-- Selected source routines only; no dispatch-project authorization or external-table stubs.
-- The three existing CODE routines are replaced in place, preserving their staging ACLs.
BEGIN;

CREATE FUNCTION public.audit_logs_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  RAISE EXCEPTION 'Audit log is append-only: entries cannot be changed or deleted';
END $function$
;

CREATE FUNCTION public.guard_code_acceptance_reservation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE scope jsonb; budget numeric;
BEGIN
  SELECT resources INTO scope FROM public.action_requests WHERE id = NEW.request_id;
  IF scope->>'acceptance' = 'true' THEN
    IF jsonb_typeof(scope->'taskBudgetUsd') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Acceptance budget unavailable';
    END IF;
    budget := (scope->>'taskBudgetUsd')::numeric;
    IF scope->>'repo' IS DISTINCT FROM 'OMERTA-ROW/jackboy-dev-control'
      OR scope->>'ref' IS DISTINCT FROM 'main'
      OR coalesce(scope->>'lane', 'reviewed') <> 'reviewed'
      OR budget <= 0 OR budget > 1 OR NEW.reserved_usd > budget
      OR NEW.reserved_usd <= 0 OR NEW.reserved_usd > 1 THEN
      RAISE EXCEPTION 'Acceptance scope or reservation exceeds owner approval';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE FUNCTION public.code_total_spend_committed()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT (
    coalesce((SELECT sum(r.reserved_usd) FROM public.code_spend_reservations AS r), 0)
    + coalesce((SELECT sum(u.cost_usd) FROM public.code_usage_events AS u), 0)
    + coalesce((
        SELECT sum(greatest(c.held - coalesce(r.reserved_usd, 0), 0))
        FROM (
          SELECT request_id, public.code_provider_call_holds(request_id) AS held
          FROM public.code_provider_calls
          GROUP BY request_id
        ) AS c
        LEFT JOIN public.code_spend_reservations AS r ON r.request_id = c.request_id
      ), 0)
  )::numeric(14,6);
$function$
;

CREATE FUNCTION public.code_total_spend_guard_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  lim numeric;
  committed numeric;
  independent numeric;
  missing text[] := ARRAY[]::text[];
BEGIN
  SELECT total_spend_limit_usd INTO lim FROM public.code_runtime_controls WHERE singleton = true;
  IF lim IS NULL OR lim <= 0 OR lim > 10.00 THEN
    missing := missing || 'total_spend_limit_usd'::text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.code_runtime_controls'::regclass
      AND conname = 'code_runtime_controls_total_spend_limit_usd_check'
      AND contype = 'c' AND convalidated
  ) THEN
    missing := missing || 'total_spend_limit_check'::text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.code_spend_reservations'::regclass
      AND tgname = 'code_spend_reservations_total_guard' AND tgenabled IN ('O', 'A')
  ) THEN
    missing := missing || 'reservation_trigger'::text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.code_usage_events'::regclass
      AND tgname = 'code_usage_events_total_guard' AND tgenabled IN ('O', 'A')
  ) THEN
    missing := missing || 'usage_trigger'::text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.code_provider_calls'::regclass
      AND tgname = 'code_provider_calls_total_guard' AND tgenabled IN ('O', 'A')
  ) THEN
    missing := missing || 'provider_call_trigger'::text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = 'public.claim_code_runtime_slot(uuid,text,text,text,bigint)'::regprocedure
      AND prosrc LIKE '%public.code_total_spend_committed()%'
  ) THEN
    missing := missing || 'claim_check'::text;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = 'public.admit_code_provider_call(uuid,bigint,text,text,numeric)'::regprocedure
      AND prosrc LIKE '%public.code_total_spend_committed()%'
  ) THEN
    missing := missing || 'provider_call_check'::text;
  END IF;

  committed := public.code_total_spend_committed();
  -- Independent recomputation: a replaced committed() that under-reports is detected here.
  SELECT coalesce((SELECT sum(reserved_usd) FROM public.code_spend_reservations), 0)
       + coalesce((SELECT sum(cost_usd) FROM public.code_usage_events), 0)
    INTO independent;
  IF committed IS NULL OR committed < independent THEN
    missing := missing || 'committed_total'::text;
  END IF;

  RETURN jsonb_build_object(
    'enforced', cardinality(missing) = 0,
    'missing', to_jsonb(missing),
    'limit_usd', lim,
    'committed_usd', committed,
    'remaining_usd', CASE WHEN lim IS NULL OR committed IS NULL THEN NULL ELSE greatest(lim - committed, 0) END,
    'exhausted', lim IS NULL OR committed IS NULL OR committed >= lim
  );
END;
$function$
;

CREATE FUNCTION public.code_total_spend_guard_enforced()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT coalesce((public.code_total_spend_guard_status()->>'enforced')::boolean, false);
$function$
;

CREATE FUNCTION public.code_total_spend_guard_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  lim numeric;
  committed numeric;
BEGIN
  SELECT total_spend_limit_usd INTO lim
    FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  committed := public.code_total_spend_committed();
  IF lim IS NULL OR committed IS NULL OR committed > lim THEN
    -- Nested IFs: PL/pgSQL does not short-circuit, and NEW does not exist for statement triggers.
    IF TG_LEVEL = 'ROW' AND TG_TABLE_NAME = 'code_spend_reservations' AND TG_OP = 'INSERT' THEN
      IF NEW.status = 'reserved' THEN
        RAISE EXCEPTION 'CODE total spend guard: this reservation would exceed the cumulative spending limit';
      END IF;
    END IF;
    UPDATE public.code_runtime_controls
      SET kill_switch = true,
          enabled = false,
          paused_reason = 'Paused: cumulative CODE spending reached the total limit',
          updated_at = now()
      WHERE singleton = true;
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (NULL, 'code.total_spend_cap_pause',
        jsonb_build_object('limit_usd', lim, 'committed_usd', committed, 'source', TG_TABLE_NAME),
        'paused');
  END IF;
  RETURN NULL;
END;
$function$
;

CREATE FUNCTION public.code_spend_meter_status()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  controls public.code_runtime_controls%ROWTYPE;
  day_start timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  provider_today numeric(14,6);
  calls_today numeric(14,6);
  open_headroom numeric(14,6);
  gateway_today numeric(14,6);
  gateway_hour numeric(14,6);
  measured numeric(14,6);
  unreported date[];
  bypass date[];
  reasons text[] := ARRAY[]::text[];
BEGIN
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true;
  IF controls.singleton IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('ok', false, 'reasons', jsonb_build_array('controls_missing'), 'measured_at', now());
  END IF;

  SELECT coalesce(sum(cost_usd), 0) INTO provider_today
    FROM public.code_usage_events WHERE occurred_at >= day_start;
  SELECT coalesce(sum(CASE status WHEN 'settled' THEN greatest(actual_usd, 0) WHEN 'aborted' THEN 0 ELSE ceiling_usd END), 0)
    INTO calls_today FROM public.code_provider_calls WHERE created_at >= day_start;
  SELECT coalesce(sum(greatest(r.reserved_usd - public.code_provider_call_holds(r.request_id), 0)), 0)
    INTO open_headroom FROM public.code_spend_reservations AS r WHERE r.status = 'reserved';
  gateway_today := calls_today + open_headroom;
  SELECT coalesce(sum(CASE status WHEN 'settled' THEN greatest(actual_usd, 0) WHEN 'aborted' THEN 0 ELSE ceiling_usd END), 0)
    INTO gateway_hour FROM public.code_provider_calls WHERE created_at >= now() - interval '1 hour';
  measured := greatest(provider_today, gateway_today);

  -- Closed days (older than yesterday) on which the gateway dispatched calls.
  WITH days AS (
    SELECT (c.dispatched_at AT TIME ZONE 'UTC')::date AS d,
      sum(CASE c.status WHEN 'settled' THEN greatest(c.actual_usd, 0) WHEN 'aborted' THEN 0 ELSE c.ceiling_usd END) AS gateway_usd
    FROM public.code_provider_calls AS c
    WHERE c.dispatched_at IS NOT NULL AND c.dispatched_at < day_start - interval '1 day'
    GROUP BY 1
  ), checked AS (
    SELECT days.d, days.gateway_usd,
      EXISTS (
        SELECT 1 FROM public.code_provider_cost_day_reports AS rep
        WHERE rep.utc_day = days.d
          AND rep.synced_at >= ((days.d + 1)::timestamp AT TIME ZONE 'UTC')
            + make_interval(secs => controls.closed_day_lag_seconds)
      ) AS reported,
      coalesce((
        SELECT sum(u.cost_usd) FROM public.code_usage_events AS u
        WHERE u.source = 'openai_org_costs'
          AND u.occurred_at >= (days.d::timestamp AT TIME ZONE 'UTC')
          AND u.occurred_at < ((days.d + 1)::timestamp AT TIME ZONE 'UTC')
      ), 0) AS provider_usd
    FROM days
  )
  SELECT
    coalesce(array_agg(d ORDER BY d) FILTER (WHERE NOT reported), ARRAY[]::date[]),
    coalesce(array_agg(d ORDER BY d) FILTER (WHERE reported AND provider_usd - gateway_usd > 0.01), ARRAY[]::date[])
    INTO unreported, bypass
    FROM checked;

  IF NOT public.code_total_spend_guard_enforced() THEN
    reasons := reasons || 'total_guard'::text;
  END IF;
  IF controls.daily_spend_limit_usd IS NULL OR controls.per_task_reserve_usd IS NULL
    OR measured + controls.per_task_reserve_usd > controls.daily_spend_limit_usd
  THEN
    reasons := reasons || 'daily_limit'::text;
  END IF;
  IF controls.daily_spend_limit_usd IS NULL OR gateway_hour >= controls.daily_spend_limit_usd * 0.5 THEN
    reasons := reasons || 'hourly_spike'::text;
  END IF;
  IF controls.usage_spike THEN
    reasons := reasons || 'usage_spike'::text;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.code_provider_calls
    WHERE overrun AND coalesce(finished_at, created_at) >= now() - interval '24 hours'
  ) THEN
    reasons := reasons || 'recent_overrun'::text;
  END IF;
  IF cardinality(unreported) > 0 THEN
    reasons := reasons || 'unreported_days'::text;
  END IF;
  IF cardinality(bypass) > 0 THEN
    reasons := reasons || 'bypass_suspected'::text;
  END IF;

  RETURN jsonb_build_object(
    'ok', cardinality(reasons) = 0,
    'reasons', to_jsonb(reasons),
    'measured_at', now(),
    'measured_today_usd', measured,
    'gateway_today_usd', gateway_today,
    'provider_today_usd', provider_today,
    'gateway_hour_usd', gateway_hour,
    'daily_limit_usd', controls.daily_spend_limit_usd,
    'per_task_reserve_usd', controls.per_task_reserve_usd,
    'unreported_days', to_jsonb(unreported),
    'bypass_days', to_jsonb(bypass)
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.admit_code_provider_call(p_request_id uuid, p_run_id bigint, p_call_key text, p_model text, p_ceiling_usd numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  controls public.code_runtime_controls%ROWTYPE;
  reservation public.code_spend_reservations%ROWTYPE;
  owner_id uuid;
  call_id uuid;
BEGIN
  PERFORM 1 FROM public.automation_policy WHERE id=1 FOR SHARE;
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton=true FOR UPDATE;
  IF controls.enabled IS DISTINCT FROM true OR controls.kill_switch IS DISTINCT FROM false
    OR NOT EXISTS(SELECT 1 FROM public.automation_policy WHERE id=1 AND paused=false)
    OR controls.stop_requested_at IS NOT NULL OR controls.cancellation_status IS DISTINCT FROM 'not_needed'
    OR controls.active_request_id IS DISTINCT FROM p_request_id OR controls.active_run_id IS DISTINCT FROM p_run_id
  THEN RAISE EXCEPTION 'CODE provider call blocked: runtime is not authorised for this task'; END IF;
  IF controls.total_spend_limit_usd IS NULL OR public.code_total_spend_committed()>controls.total_spend_limit_usd
    OR NOT public.code_total_spend_guard_enforced()
  THEN RAISE EXCEPTION 'CODE provider call blocked: cumulative spending limit reached or guard not intact'; END IF;
  SELECT * INTO reservation FROM public.code_spend_reservations
    WHERE request_id=p_request_id AND run_id=p_run_id FOR UPDATE;
  IF NOT FOUND OR reservation.status<>'reserved'
  THEN RAISE EXCEPTION 'CODE provider call blocked: no active spend reservation'; END IF;
  SELECT requested_by INTO owner_id FROM public.action_requests WHERE id=p_request_id;
  IF owner_id IS NULL OR p_ceiling_usd IS NULL OR p_ceiling_usd<=0
    OR p_model IS NULL OR length(p_model) NOT BETWEEN 1 AND 100
    OR p_call_key IS NULL OR p_call_key !~ '^[A-Za-z0-9_-]{8,64}$'
  THEN RAISE EXCEPTION 'CODE provider call blocked: invalid request'; END IF;
  IF (SELECT count(*) FROM public.code_provider_calls WHERE request_id=p_request_id)>=500
  THEN RAISE EXCEPTION 'CODE provider call blocked: call count limit reached'; END IF;
  IF public.code_provider_call_holds(p_request_id)+p_ceiling_usd>reservation.reserved_usd
  THEN RAISE EXCEPTION 'CODE provider call blocked: task spending reservation would be exceeded'; END IF;
  INSERT INTO public.code_provider_calls(request_id,run_id,call_key,model,ceiling_usd)
    VALUES(p_request_id,p_run_id,p_call_key,p_model,p_ceiling_usd) RETURNING id INTO call_id;
  INSERT INTO public.audit_logs(actor,action,detail,outcome)
    VALUES(owner_id,'code.provider_call_admitted',jsonb_build_object('call_id',call_id,'request_id',p_request_id,'model',p_model,
      'ceiling_usd',p_ceiling_usd),'admitted');
  RETURN call_id;
END $function$
;

CREATE OR REPLACE FUNCTION public.claim_code_runtime_slot(p_request_id uuid, p_repository text, p_ref text, p_workflow_sha text, p_run_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  controls public.code_runtime_controls%ROWTYPE;
  request_row public.action_requests%ROWTYPE;
  current_spend numeric(12,6);
  hourly_spend numeric(12,6);
  held_spend numeric(12,6);
  total_committed numeric(14,6);
BEGIN
  PERFORM 1 FROM public.automation_policy WHERE id=1 FOR SHARE;
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton=true FOR UPDATE;
  SELECT * INTO request_row FROM public.action_requests WHERE id=p_request_id FOR UPDATE;
  SELECT coalesce(sum(cost_usd),0) INTO current_spend FROM public.code_usage_events
    WHERE occurred_at>=date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  SELECT coalesce(sum(cost_usd),0) INTO hourly_spend FROM public.code_usage_events
    WHERE occurred_at>=now()-interval '1 hour';
  SELECT coalesce(sum(reserved_usd),0) INTO held_spend FROM public.code_spend_reservations WHERE status<>'settled';
  total_committed := public.code_total_spend_committed();
  IF controls.singleton IS DISTINCT FROM true OR controls.enabled IS DISTINCT FROM true
    OR controls.kill_switch IS DISTINCT FROM false
    OR NOT EXISTS(SELECT 1 FROM public.automation_policy WHERE id=1 AND paused=false)
    OR controls.active_request_id IS NOT NULL OR controls.consecutive_failures>=2 OR controls.usage_spike
    OR NOT controls.provider_hard_cap_verified OR controls.provider_usage_at IS NULL
    OR controls.provider_usage_at<now()-interval '5 minutes' OR controls.provider_usage_at>now()+interval '30 seconds'
    OR current_spend>=controls.daily_spend_limit_usd OR hourly_spend>=controls.daily_spend_limit_usd*0.5
    OR current_spend+held_spend+controls.per_task_reserve_usd>controls.daily_spend_limit_usd
    OR controls.total_spend_limit_usd IS NULL OR total_committed IS NULL
    OR total_committed+controls.per_task_reserve_usd>controls.total_spend_limit_usd
    OR NOT public.code_total_spend_guard_enforced()
    OR (request_row.resources->>'acceptance'='true' AND public.code_acceptance_guard_status() IS DISTINCT FROM true)
    OR p_repository IS NULL OR p_ref IS NULL OR p_workflow_sha IS NULL
    OR controls.allowed_targets->p_repository->>'ref' IS DISTINCT FROM p_ref
    OR controls.allowed_targets->p_repository->>'workflowSha' IS DISTINCT FROM p_workflow_sha
    OR request_row.id IS NULL OR request_row.status<>'allowed' OR request_row.runner_claimed_at IS NULL
    OR request_row.runner_run_id<>p_run_id OR request_row.resources->>'repo' IS DISTINCT FROM p_repository
    OR request_row.resources->>'ref' IS DISTINCT FROM p_ref
    OR request_row.resources->>'workflowSha' IS DISTINCT FROM p_workflow_sha
    OR EXISTS(SELECT 1 FROM public.code_spend_reservations WHERE request_id=p_request_id)
  THEN
    INSERT INTO public.audit_logs(actor,action,detail,outcome)
      VALUES(request_row.requested_by,'code.task_blocked',jsonb_build_object('request',p_request_id,'repo',p_repository,
        'total_committed_usd',total_committed,'total_limit_usd',controls.total_spend_limit_usd),'blocked');
    RETURN false;
  END IF;
  INSERT INTO public.code_spend_reservations(request_id,run_id,reserved_usd)
    VALUES(p_request_id,p_run_id,controls.per_task_reserve_usd);
  UPDATE public.code_runtime_controls SET active_request_id=p_request_id,active_run_id=p_run_id,updated_at=now() WHERE singleton=true;
  INSERT INTO public.audit_logs(actor,action,detail,outcome)
    VALUES(request_row.requested_by,'code.task_started',jsonb_build_object('request',p_request_id,'repo',p_repository,'run_id',p_run_id,
      'reserved_usd',controls.per_task_reserve_usd,'total_committed_usd',total_committed+controls.per_task_reserve_usd),'ok');
  RETURN true;
END $function$
;

CREATE OR REPLACE FUNCTION public.dispatch_code_provider_call(p_call_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE controls public.code_runtime_controls%ROWTYPE; call_row public.code_provider_calls%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.automation_policy WHERE id=1 FOR SHARE;
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton=true FOR UPDATE;
  SELECT * INTO call_row FROM public.code_provider_calls WHERE id=p_call_id FOR UPDATE;
  IF NOT FOUND OR call_row.status<>'admitted' OR controls.enabled IS DISTINCT FROM true
    OR controls.kill_switch IS DISTINCT FROM false
    OR NOT EXISTS(SELECT 1 FROM public.automation_policy WHERE id=1 AND paused=false)
    OR controls.stop_requested_at IS NOT NULL OR controls.cancellation_status IS DISTINCT FROM 'not_needed'
    OR controls.active_request_id IS DISTINCT FROM call_row.request_id OR controls.active_run_id IS DISTINCT FROM call_row.run_id
  THEN RAISE EXCEPTION 'CODE provider call dispatch blocked'; END IF;
  UPDATE public.code_provider_calls SET status='dispatched',dispatched_at=now() WHERE id=p_call_id;
END $function$
;

CREATE FUNCTION public.code_acceptance_guard_status()
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.code_spend_reservations'::regclass
      AND tgname = 'code_acceptance_reservation_guard'
      AND tgfoid = 'public.guard_code_acceptance_reservation()'::regprocedure
      AND tgenabled = 'O' AND NOT tgisinternal
      AND tgtype = 7 -- ROW | BEFORE | INSERT, no other event.
      AND tgqual IS NULL AND tgnargs = 0 AND tgconstraint = 0
  );
$function$
;

CREATE FUNCTION public.code_independent_controls_installed()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT count(*) = 3
    FROM pg_catalog.pg_proc
    WHERE oid IN (
        'public.claim_code_runtime_slot(uuid,text,text,text,bigint)'::regprocedure,
        'public.admit_code_provider_call(uuid,bigint,text,text,numeric)'::regprocedure,
        'public.dispatch_code_provider_call(uuid)'::regprocedure)
      AND prosrc LIKE '%NOT EXISTS (SELECT 1 FROM public.automation_policy WHERE id = 1 AND paused = false)%';
$function$
;

CREATE FUNCTION public.code_runtime_controls_activation_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  turning_on boolean;
  stamping boolean;
BEGIN
  -- Nested on TG_OP: PL/pgSQL does not short-circuit, so OLD is only read for UPDATE.
  IF TG_OP = 'INSERT' THEN
    turning_on := NEW.enabled IS TRUE OR NEW.kill_switch IS NOT TRUE;
    stamping := NEW.provider_usage_at IS NOT NULL;
  ELSE
    turning_on := (NEW.enabled IS TRUE AND OLD.enabled IS NOT TRUE)
      OR (NEW.kill_switch IS NOT TRUE AND OLD.kill_switch IS TRUE);
    stamping := NEW.provider_usage_at IS NOT NULL
      AND NEW.provider_usage_at IS DISTINCT FROM OLD.provider_usage_at;
  END IF;
  IF turning_on
    AND coalesce(current_setting('jackboy.code_activation', true), '') <> 'owner-enabled'
  THEN
    RAISE EXCEPTION 'CODE can only be turned on through set_code_enabled, and its Emergency Stop released only through release_code_emergency_stop';
  END IF;
  -- Freshness can only come from the meter; clearing it (NULL) is always allowed.
  IF stamping AND coalesce(current_setting('jackboy.code_meter', true), '') <> 'refresh' THEN
    RAISE EXCEPTION 'provider_usage_at can only be stamped by refresh_code_spend_meter';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE FUNCTION public.code_runtime_controls_hard_cap_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.provider_hard_cap_verified IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_hard_cap_verified IS TRUE THEN
    -- Already verified: other columns (kill switch, pauses, usage) must always be writable.
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('jackboy.code_hard_cap_attestation', true), '') <> 'owner-attested' THEN
    RAISE EXCEPTION 'provider_hard_cap_verified can only be set by set_code_provider_hard_cap_verified';
  END IF;
  IF NOT public.code_total_spend_guard_enforced() THEN
    RAISE EXCEPTION 'provider_hard_cap_verified requires the cumulative spend guard to be enforced';
  END IF;
  IF NEW.total_spend_limit_usd IS NULL OR NEW.total_spend_limit_usd > 10.00
    OR NEW.enabled IS DISTINCT FROM false
    OR NEW.kill_switch IS DISTINCT FROM true
    OR NEW.active_request_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'provider_hard_cap_verified can only be set while CODE is disabled and stopped';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE FUNCTION public.refresh_code_spend_meter()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  status jsonb;
  previous jsonb;
  ok boolean;
BEGIN
  SELECT spend_meter INTO previous FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  status := public.code_spend_meter_status();
  ok := coalesce((status->>'ok')::boolean, false);
  PERFORM pg_catalog.set_config('jackboy.code_meter', 'refresh', true);
  UPDATE public.code_runtime_controls
    SET provider_usage_at = CASE WHEN ok THEN now() ELSE NULL END,
        spend_meter = status,
        updated_at = now()
    WHERE singleton = true;
  PERFORM pg_catalog.set_config('jackboy.code_meter', '', true);
  -- Audit when the meter becomes blocked or its reasons change, not on every repeated read.
  IF NOT ok AND (previous IS NULL OR coalesce((previous->>'ok')::boolean, false)
    OR previous->'reasons' IS DISTINCT FROM status->'reasons')
  THEN
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (NULL, 'code.spend_meter_blocked', status, 'blocked');
  END IF;
  RETURN status;
END;
$function$
;

CREATE FUNCTION public.set_code_provider_hard_cap_verified(p_actor uuid, p_verified boolean, p_evidence text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  guard jsonb;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only the owner can change the CODE hard-cap verification';
  END IF;
  IF p_verified IS NULL THEN
    RAISE EXCEPTION 'A verification value is required';
  END IF;
  IF p_evidence IS NULL OR char_length(btrim(p_evidence)) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'Describe the evidence for this change (10 to 500 characters)';
  END IF;
  PERFORM 1 FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  guard := public.code_total_spend_guard_status();
  IF p_verified AND NOT coalesce((guard->>'enforced')::boolean, false) THEN
    RAISE EXCEPTION 'The cumulative spend guard is not enforced: %', guard->'missing';
  END IF;
  PERFORM pg_catalog.set_config('jackboy.code_hard_cap_attestation', 'owner-attested', true);
  UPDATE public.code_runtime_controls
    SET provider_hard_cap_verified = p_verified,
        updated_at = now()
    WHERE singleton = true;
  PERFORM pg_catalog.set_config('jackboy.code_hard_cap_attestation', '', true);
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (p_actor,
      CASE WHEN p_verified THEN 'code.hard_cap_verified' ELSE 'code.hard_cap_unverified' END,
      jsonb_build_object('evidence', left(btrim(p_evidence), 500), 'guard', guard),
      'ok');
  RETURN guard;
END;
$function$
;

CREATE FUNCTION public.set_code_enabled(p_actor uuid, p_enabled boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  controls public.code_runtime_controls%ROWTYPE;
  global_paused boolean;
  guard jsonb;
  meter jsonb;
  target jsonb;
  reasons text[] := ARRAY[]::text[];
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only the owner can change the CODE enabled setting';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'The CODE enabled setting must be on or off';
  END IF;
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  IF controls.singleton IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'CODE runtime controls are missing';
  END IF;
  SELECT ap.paused INTO global_paused FROM public.automation_policy AS ap WHERE ap.id = 1;

  IF controls.enabled = p_enabled THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'enabled', p_enabled,
      'emergency_stop', controls.kill_switch, 'kill_switch', global_paused, 'reasons', '[]'::jsonb);
  END IF;

  IF NOT p_enabled THEN
    -- Turning CODE off is always allowed and never touches the Emergency Stop or the Kill Switch.
    UPDATE public.code_runtime_controls SET enabled = false, updated_at = now() WHERE singleton = true;
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (p_actor, 'code.enabled_off', jsonb_build_object('emergency_stop_unchanged', controls.kill_switch,
        'kill_switch_unchanged', global_paused, 'active_request_id', controls.active_request_id), 'ok');
    RETURN jsonb_build_object('ok', true, 'changed', true, 'enabled', false,
      'emergency_stop', controls.kill_switch, 'kill_switch', global_paused, 'reasons', '[]'::jsonb);
  END IF;

  -- Turning CODE on keeps every owner authorisation, allowlist, metering and budget check. The Kill
  -- Switch and the Emergency Stop are separate controls: they are NOT changed here, and CODE admission
  -- still refuses while either is on.
  guard := public.code_total_spend_guard_status();
  meter := public.code_spend_meter_status();
  target := controls.allowed_targets->'OMERTA-ROW/jackboy-dev-control';
  IF controls.active_request_id IS NOT NULL OR controls.active_run_id IS NOT NULL THEN
    reasons := reasons || 'active_task'::text;
  END IF;
  IF controls.consecutive_failures >= 2 THEN
    reasons := reasons || 'failure_stop'::text;
  END IF;
  IF controls.usage_spike THEN
    reasons := reasons || 'usage_spike'::text;
  END IF;
  IF controls.cancellation_status NOT IN ('not_needed', 'confirmed', 'completed') THEN
    reasons := reasons || 'cancellation_unconfirmed'::text;
  END IF;
  IF controls.provider_hard_cap_verified IS NOT TRUE THEN
    reasons := reasons || 'hard_cap_unverified'::text;
  END IF;
  IF NOT coalesce((guard->>'enforced')::boolean, false) THEN
    reasons := reasons || 'total_guard'::text;
  ELSIF (guard->>'committed_usd')::numeric + controls.per_task_reserve_usd > (guard->>'limit_usd')::numeric THEN
    reasons := reasons || 'total_limit'::text;
  END IF;
  IF NOT coalesce((meter->>'ok')::boolean, false) THEN
    reasons := reasons || 'spend_meter'::text;
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(controls.allowed_targets)) <> 1
    OR target IS NULL
    OR target->>'ref' IS DISTINCT FROM 'main'
    OR coalesce(target->>'workflowSha', '') !~ '^[a-f0-9]{40}$'
  THEN
    reasons := reasons || 'target_allowlist'::text;
  END IF;

  IF cardinality(reasons) > 0 THEN
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (p_actor, 'code.enable_refused',
        jsonb_build_object('reasons', to_jsonb(reasons), 'guard', guard, 'meter', meter), 'blocked');
    RETURN jsonb_build_object('ok', false, 'changed', false, 'enabled', false,
      'emergency_stop', controls.kill_switch, 'kill_switch', global_paused, 'reasons', to_jsonb(reasons));
  END IF;

  PERFORM pg_catalog.set_config('jackboy.code_activation', 'owner-enabled', true);
  UPDATE public.code_runtime_controls SET enabled = true, updated_at = now() WHERE singleton = true;
  PERFORM pg_catalog.set_config('jackboy.code_activation', '', true);
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (p_actor, 'code.enabled_on', jsonb_build_object('emergency_stop_unchanged', controls.kill_switch,
      'kill_switch_unchanged', global_paused, 'workflow_sha', target->>'workflowSha', 'guard', guard, 'meter', meter), 'ok');
  RETURN jsonb_build_object('ok', true, 'changed', true, 'enabled', true,
    'emergency_stop', controls.kill_switch, 'kill_switch', global_paused, 'reasons', '[]'::jsonb);
END;
$function$
;

CREATE FUNCTION public.enable_code_runtime(p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN public.set_code_enabled(p_actor, true);
END;
$function$
;

CREATE FUNCTION public.release_code_emergency_stop(p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  controls public.code_runtime_controls%ROWTYPE;
  global_paused boolean;
  guard jsonb;
  reasons text[] := ARRAY[]::text[];
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only the owner can release the CODE emergency stop';
  END IF;
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  IF controls.singleton IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'CODE runtime controls are missing';
  END IF;
  SELECT ap.paused INTO global_paused FROM public.automation_policy AS ap WHERE ap.id = 1;

  IF controls.kill_switch IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', true, 'changed', false, 'emergency_stop', false,
      'enabled', controls.enabled, 'kill_switch', global_paused, 'reasons', '[]'::jsonb);
  END IF;

  -- Releasing the stop never bypasses an emergency protection or the spending caps.
  guard := public.code_total_spend_guard_status();
  IF controls.active_request_id IS NOT NULL OR controls.active_run_id IS NOT NULL THEN
    reasons := reasons || 'active_task'::text;
  END IF;
  IF controls.cancellation_status NOT IN ('not_needed', 'confirmed', 'completed') THEN
    reasons := reasons || 'cancellation_unconfirmed'::text;
  END IF;
  IF controls.consecutive_failures >= 2 THEN
    reasons := reasons || 'failure_stop'::text;
  END IF;
  IF controls.usage_spike THEN
    reasons := reasons || 'usage_spike'::text;
  END IF;
  IF controls.provider_hard_cap_verified IS NOT TRUE THEN
    reasons := reasons || 'hard_cap_unverified'::text;
  END IF;
  IF NOT coalesce((guard->>'enforced')::boolean, false) THEN
    reasons := reasons || 'total_guard'::text;
  END IF;

  IF cardinality(reasons) > 0 THEN
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (p_actor, 'code.emergency_stop_release_refused',
        jsonb_build_object('reasons', to_jsonb(reasons), 'guard', guard), 'blocked');
    RETURN jsonb_build_object('ok', false, 'changed', false, 'emergency_stop', true,
      'enabled', controls.enabled, 'kill_switch', global_paused, 'reasons', to_jsonb(reasons));
  END IF;

  PERFORM pg_catalog.set_config('jackboy.code_activation', 'owner-enabled', true);
  UPDATE public.code_runtime_controls
    SET kill_switch = false,
        paused_reason = NULL,
        stop_requested_at = NULL,
        cancellation_status = 'not_needed',
        updated_at = now()
    WHERE singleton = true;
  PERFORM pg_catalog.set_config('jackboy.code_activation', '', true);
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (p_actor, 'code.emergency_stop_released', jsonb_build_object('code_enabled_unchanged', controls.enabled,
      'kill_switch_unchanged', global_paused, 'guard', guard), 'ok');
  RETURN jsonb_build_object('ok', true, 'changed', true, 'emergency_stop', false,
    'enabled', controls.enabled, 'kill_switch', global_paused, 'reasons', '[]'::jsonb);
END;
$function$
;

CREATE FUNCTION public.claim_omni_execution_nonce(_client text, _nonce text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE prefix text := 'execution:'||_client||':';
BEGIN
  IF _client IS NULL OR _client !~ '^[A-Za-z0-9_-]{1,64}$'
    OR _nonce IS NULL OR _nonce !~ '^[a-f0-9]{32}$'
  THEN RAISE EXCEPTION 'Invalid execution nonce'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(prefix,0));
  DELETE FROM public.omni_callback_nonces WHERE nonce LIKE 'execution:%'
    AND received_at<now()-interval '60 seconds';
  IF (SELECT count(*) FROM public.omni_callback_nonces
      WHERE left(nonce,length(prefix))=prefix)>=400
  THEN RAISE EXCEPTION 'Execution request rate exceeded'; END IF;
  INSERT INTO public.omni_callback_nonces(nonce) VALUES(prefix||_nonce);
END $function$
;

CREATE FUNCTION public.omni_link_live()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE((
    SELECT verified AND verified_at IS NOT NULL AND config_hash IS NOT NULL
      AND verified_at > now() - interval '5 minutes' AND verified_at <= now() + interval '30 seconds'
    FROM public.omni_connection WHERE id
  ), false)
$function$
;

CREATE FUNCTION public.omni_link_configuration_authorize(_client_id text, _project_id uuid, _owner_id uuid, _nonce text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF _client_id IS NULL OR _client_id !~ '^[a-zA-Z0-9_-]{1,64}$'
     OR _nonce IS NULL OR _nonce !~ '^[a-f0-9]{32}$'
     OR NOT EXISTS (
       SELECT 1 FROM public.owner_projects
       WHERE id = _project_id AND created_by = _owner_id AND active
     )
     OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _owner_id AND role = 'owner')
     OR COALESCE((SELECT paused FROM public.automation_policy WHERE id = 1), true)
  THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('omni-config:' || _client_id, 0));
  DELETE FROM public.omni_callback_nonces
    WHERE starts_with(nonce, 'link-config:' || _client_id || ':') AND received_at < now() - interval '10 minutes';
  IF (SELECT count(*) FROM public.omni_callback_nonces
      WHERE starts_with(nonce, 'link-config:' || _client_id || ':')) >= 60
  THEN RETURN false; END IF;
  INSERT INTO public.omni_callback_nonces(nonce)
    VALUES ('link-config:' || _client_id || ':' || _nonce) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.site_log(actor, action, category, status, summary, project_id)
    VALUES ('omni-link', 'omni.link.configuration_check', 'config', 'info',
            'Authenticated read-only runner configuration check', _project_id);
  RETURN true;
END $function$
;

CREATE FUNCTION public.save_omni_link_approval(_actor uuid, _grant uuid, _approval uuid, _expires timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g public.step_up_grants;
  replaced boolean;
BEGIN
  IF _actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _actor AND role = 'owner') THEN
    RAISE EXCEPTION 'Owner required';
  END IF;
  SELECT * INTO g FROM public.step_up_grants
    WHERE id = _grant AND user_id = _actor AND action = 'omni_link_approval_save'
      AND target = 'omni-link-approval' AND used_at IS NULL AND expires_at > now()
    FOR UPDATE;
  IF NOT FOUND OR g.credential_id IS NULL OR g.credential_id = '' OR g.credential_id LIKE 'recent:%' THEN
    RAISE EXCEPTION 'Fresh passkey confirmation required';
  END IF;
  IF _approval IS NULL OR _expires IS NULL THEN
    RAISE EXCEPTION 'Approval ID and expiry are both required';
  END IF;
  IF _expires <= now() THEN
    RAISE EXCEPTION 'Approval expiry must be in the future';
  END IF;
  IF _expires > now() + interval '24 hours' THEN
    RAISE EXCEPTION 'Approval expiry must be within 24 hours';
  END IF;

  UPDATE public.step_up_grants SET used_at = now() WHERE id = _grant;
  replaced := EXISTS (SELECT 1 FROM public.omni_link_approval WHERE id = 1);
  INSERT INTO public.omni_link_approval(id, approval_id, expires_at, saved_by, saved_at)
    VALUES (1, _approval, _expires, _actor, now())
    ON CONFLICT (id) DO UPDATE
      SET approval_id = EXCLUDED.approval_id, expires_at = EXCLUDED.expires_at,
          saved_by = EXCLUDED.saved_by, saved_at = EXCLUDED.saved_at;
  INSERT INTO public.site_log(actor, action, category, status, summary, detail)
    VALUES (_actor::text, 'omni_link.approval_saved', 'config', 'ok',
      'Owner saved a new OMNI link approval with a fresh passkey (values not logged). Railway must be updated by hand.',
      jsonb_build_object('replacedPrevious', replaced,
        'validForHours', round(extract(epoch FROM (_expires - now())) / 3600.0, 1)));
  RETURN jsonb_build_object('saved', true, 'replacedPrevious', replaced,
    'validForHours', round(extract(epoch FROM (_expires - now())) / 3600.0, 1));
END $function$
;

CREATE FUNCTION public.omni_autonomy_authorization_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'OMNI authorization history is kept; revoke instead of deleting';
  END IF;
  IF ROW(NEW.id, NEW.owner_id, NEW.client_id, NEW.project_id, NEW.approval_id, NEW.step8_job_id,
         NEW.daily_limit_usd, NEW.per_call_limit_usd, NEW.per_task_reserve_usd, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.owner_id, OLD.client_id, OLD.project_id, OLD.approval_id, OLD.step8_job_id,
         OLD.daily_limit_usd, OLD.per_call_limit_usd, OLD.per_task_reserve_usd, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'OMNI authorization scope is immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND ROW(NEW.revoked_at, NEW.revoked_reason) IS DISTINCT FROM ROW(OLD.revoked_at, OLD.revoked_reason) THEN
    RAISE EXCEPTION 'OMNI authorization revocation is final';
  END IF;
  IF NEW.capabilities IS DISTINCT FROM OLD.capabilities AND (
       OLD.revoked_at IS NOT NULL OR OLD.created_at IS DISTINCT FROM now()
       OR NOT (NEW.capabilities <@ OLD.capabilities)) THEN
    RAISE EXCEPTION 'OMNI capabilities can only be narrowed while the authorization is being created';
  END IF;
  RETURN NEW;
END $function$
;

CREATE FUNCTION public.omni_autonomy_authorization_action(_op text, _actor uuid, _client text, _project uuid, _step uuid, _runner_ready boolean, _reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  appr record;
  proof public.omni_inbound_jobs;
  existing public.omni_autonomy_authorizations;
  created public.omni_autonomy_authorizations;
  step public.step_up_grants;
  controls public.code_runtime_controls;
  paused boolean;
  reasons text[] := ARRAY[]::text[];
  blocked text[] := ARRAY[]::text[];
  n_auth int := 0;
  n_permits int := 0;
BEGIN
  IF _op IS NULL OR _op NOT IN ('authorize', 'revoke') THEN RAISE EXCEPTION 'Invalid authorization operation'; END IF;
  IF _actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _actor AND role = 'owner') THEN
    RAISE EXCEPTION 'Only the owner can change OMNI autonomous permission';
  END IF;
  IF _client IS NULL OR _client !~ '^[a-zA-Z0-9_-]{1,64}$' OR _project IS NULL THEN
    RAISE EXCEPTION 'OMNI client and project are required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('omni-permit:' || _client, 0));

  IF _op = 'revoke' THEN
    UPDATE public.omni_autonomy_authorizations
      SET revoked_at = now(), revoked_reason = left(COALESCE(NULLIF(trim(_reason), ''), 'revoked by owner'), 300)
      WHERE client_id = _client AND revoked_at IS NULL;
    GET DIAGNOSTICS n_auth = ROW_COUNT;
    UPDATE public.omni_execution_permits SET status = 'revoked', closed_at = now(), closed_reason = 'authorization_revoked'
      WHERE client_id = _client AND status = 'active';
    GET DIAGNOSTICS n_permits = ROW_COUNT;
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (_actor, 'omni.autonomy_revoked', jsonb_build_object('client', _client, 'authorizations', n_auth, 'permits', n_permits), 'ok');
    RETURN jsonb_build_object('ok', true, 'revokedAuthorizations', n_auth, 'revokedPermits', n_permits);
  END IF;

  SELECT approval_id, expires_at, saved_at INTO appr FROM public.omni_link_approval WHERE id = 1;
  IF appr.approval_id IS NULL OR appr.expires_at <= now() OR appr.expires_at > now() + interval '24 hours' THEN
    reasons := array_append(reasons, 'step7_approval_expired');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.owner_projects WHERE id = _project AND created_by = _actor AND active) THEN
    reasons := array_append(reasons, 'project_scope');
  END IF;
  IF appr.approval_id IS NOT NULL THEN
    SELECT * INTO proof FROM public.omni_inbound_jobs
      WHERE client_id = _client AND project_id = _project AND approval_id = appr.approval_id
        AND kind = 'protocol.self-test' AND status = 'completed'
        AND result->>'passed' = 'true' AND result->>'checks' = '3'
        AND result->>'runner' = 'restricted-protocol-self-test'
        AND updated_at >= appr.saved_at
      ORDER BY updated_at DESC LIMIT 1;
  END IF;
  IF proof.id IS NULL THEN reasons := array_append(reasons, 'step8_proof_missing'); END IF;
  IF appr.approval_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.omni_link_sessions
    WHERE client_id = _client AND project_id = _project AND approval_id = appr.approval_id
      AND expires_at > now() - interval '25 minutes'
  ) THEN reasons := array_append(reasons, 'step9_handshake_missing'); END IF;
  IF _runner_ready IS DISTINCT FROM true THEN reasons := array_append(reasons, 'runner_unavailable'); END IF;
  IF COALESCE(public.code_spend_meter_status()->>'ok', 'false') <> 'true' THEN reasons := array_append(reasons, 'meter_untrusted'); END IF;
  IF NOT COALESCE(public.code_total_spend_guard_enforced(), false) THEN reasons := array_append(reasons, 'gateway_unenforced'); END IF;

  SELECT * INTO existing FROM public.omni_autonomy_authorizations
    WHERE client_id = _client AND revoked_at IS NULL AND expires_at > now();
  IF existing.id IS NOT NULL AND existing.approval_id = appr.approval_id AND existing.project_id = _project
     AND cardinality(reasons) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'id', existing.id, 'expiresAt', existing.expires_at);
  END IF;

  IF cardinality(reasons) = 0 THEN
    SELECT * INTO step FROM public.step_up_grants
      WHERE id = _step AND user_id = _actor AND action = 'omni_autonomy'
        AND target = 'omni-autonomy:' || appr.approval_id::text
        AND used_at IS NULL AND expires_at > now() AND credential_id NOT LIKE 'recent:%'
      FOR UPDATE;
    IF step.id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.owner_passkeys WHERE user_id = _actor AND credential_id = step.credential_id
    ) THEN reasons := array_append(reasons, 'fresh_passkey_required'); END IF;
  END IF;

  IF cardinality(reasons) > 0 THEN
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (_actor, 'omni.autonomy_authorize_refused', jsonb_build_object('client', _client, 'reasons', to_jsonb(reasons)), 'refused');
    RETURN jsonb_build_object('ok', false, 'reasons', to_jsonb(reasons));
  END IF;

  UPDATE public.omni_autonomy_authorizations SET revoked_at = now(), revoked_reason = 'replaced by a new owner authorization'
    WHERE client_id = _client AND revoked_at IS NULL;
  UPDATE public.omni_execution_permits SET status = 'revoked', closed_at = now(), closed_reason = 'authorization_replaced'
    WHERE client_id = _client AND status = 'active';
  UPDATE public.step_up_grants SET used_at = now() WHERE id = step.id;
  INSERT INTO public.omni_autonomy_authorizations(owner_id, client_id, project_id, approval_id, step8_job_id, expires_at)
    VALUES (_actor, _client, _project, appr.approval_id, proof.id, appr.expires_at)
    RETURNING * INTO created;

  SELECT ap.paused INTO paused FROM public.automation_policy AS ap WHERE ap.id = 1;
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true;
  IF COALESCE(paused, true) THEN blocked := array_append(blocked, 'kill_switch_on'); END IF;
  IF controls.singleton IS DISTINCT FROM true OR controls.kill_switch THEN blocked := array_append(blocked, 'emergency_stop_engaged'); END IF;
  IF controls.singleton IS DISTINCT FROM true OR NOT controls.enabled THEN blocked := array_append(blocked, 'code_disabled'); END IF;

  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (_actor, 'omni.autonomy_authorized', jsonb_build_object('authorization', created.id, 'client', _client,
      'project', _project, 'approval', created.approval_id, 'step8_job', proof.id, 'expires_at', created.expires_at,
      'daily_limit_usd', created.daily_limit_usd, 'per_call_limit_usd', created.per_call_limit_usd,
      'per_task_reserve_usd', created.per_task_reserve_usd, 'execution_blocked_by', to_jsonb(blocked)), 'ok');
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'id', created.id, 'expiresAt', created.expires_at,
    'executionBlockedBy', to_jsonb(blocked));
END $function$
;

CREATE FUNCTION public.omni_autonomy_authorize_scoped(_actor uuid, _client text, _project uuid, _step uuid, _runner_ready boolean, _capabilities text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  caps text[];
  appr uuid;
  existing public.omni_autonomy_authorizations;
  r jsonb;
  row_caps text[];
BEGIN
  IF _actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _actor AND role = 'owner') THEN
    RAISE EXCEPTION 'Only the owner can change OMNI autonomous permission';
  END IF;
  IF _client IS NULL OR _client !~ '^[a-zA-Z0-9_-]{1,64}$' OR _project IS NULL THEN
    RAISE EXCEPTION 'OMNI client and project are required';
  END IF;
  IF _capabilities IS NULL OR array_position(_capabilities, NULL) IS NOT NULL
     OR NOT (_capabilities <@ ARRAY['autonomous','code']::text[]) THEN
    RAISE EXCEPTION 'Allowed OMNI capabilities are autonomous and code';
  END IF;
  SELECT array_agg(DISTINCT c ORDER BY c) INTO caps FROM unnest(_capabilities) AS c;
  IF caps IS NULL OR cardinality(caps) = 0 THEN
    RAISE EXCEPTION 'Choose at least one allowed OMNI capability';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('omni-permit:' || _client, 0));

  SELECT approval_id INTO appr FROM public.omni_link_approval WHERE id = 1;
  SELECT * INTO existing FROM public.omni_autonomy_authorizations
    WHERE client_id = _client AND revoked_at IS NULL AND expires_at > now();
  IF existing.id IS NOT NULL AND existing.project_id = _project AND existing.approval_id IS NOT DISTINCT FROM appr
     AND existing.capabilities IS DISTINCT FROM caps THEN
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (_actor, 'omni.autonomy_authorize_refused', jsonb_build_object('client', _client,
        'reasons', jsonb_build_array('capabilities_change_requires_revoke'),
        'current', to_jsonb(existing.capabilities), 'requested', to_jsonb(caps)), 'refused');
    RETURN jsonb_build_object('ok', false, 'reasons', jsonb_build_array('capabilities_change_requires_revoke'),
      'capabilities', to_jsonb(existing.capabilities));
  END IF;

  r := public.omni_autonomy_authorization_action('authorize', _actor, _client, _project, _step, _runner_ready, NULL);
  IF (r->>'ok')::boolean IS TRUE AND (r->>'duplicate')::boolean IS NOT TRUE THEN
    UPDATE public.omni_autonomy_authorizations SET capabilities = caps WHERE id = (r->>'id')::uuid;
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (_actor, 'omni.autonomy_scope', jsonb_build_object('authorization', (r->>'id')::uuid,
        'client', _client, 'project', _project, 'approval', appr, 'capabilities', to_jsonb(caps)), 'ok');
  END IF;
  IF (r->>'ok')::boolean IS TRUE THEN
    SELECT capabilities INTO row_caps FROM public.omni_autonomy_authorizations WHERE id = (r->>'id')::uuid;
    r := r || jsonb_build_object('capabilities', to_jsonb(row_caps));
  END IF;
  RETURN r;
END $function$
;

CREATE FUNCTION public.omni_execution_job_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
BEGIN
  IF ROW(NEW.id,NEW.project_id,NEW.owner_id,NEW.plan_sha256,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.owner_id,OLD.plan_sha256,OLD.expires_at)
    OR (OLD.state IN ('completed','failed','cancelled') AND NEW IS DISTINCT FROM OLD)
    OR (NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state='authorized' AND NEW.state IN ('running','cancel_requested')) OR
      (OLD.state='running' AND NEW.state IN ('completed','failed','cancel_requested')) OR
      (OLD.state='cancel_requested' AND NEW.state='cancelled')))
  THEN RAISE EXCEPTION 'Job scope and terminal outcome are immutable'; END IF;
  RETURN NEW;
END $function$
;

CREATE FUNCTION public.omni_execution_control_without_lease(_owner uuid, _project uuid, _approval uuid, _op text, _a jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  c public.code_runtime_controls%ROWTYPE;
  link public.omni_execution_connections%ROWTYPE;
  job public.omni_execution_jobs%ROWTYPE;
  expiry timestamptz;
  blocked boolean;
  ok boolean := false;
  guard jsonb;
  meter jsonb;
BEGIN
  IF _owner IS NULL OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_owner AND role='owner')
    OR NOT EXISTS (SELECT 1 FROM public.owner_projects WHERE id=_project AND created_by=_owner AND active)
    OR _op IS NULL OR _op NOT IN ('connect','configure','verify','arm','disarm','unconfigure','revoke','safety','authorize','claim','permission','finish')
  THEN RAISE EXCEPTION 'Execution authority denied'; END IF;
  -- The same row lock serializes job admission with the existing CODE Stop transaction.
  SELECT * INTO c FROM public.code_runtime_controls WHERE singleton FOR UPDATE;
  IF c.singleton IS DISTINCT FROM true THEN RAISE EXCEPTION 'Safety state unavailable'; END IF;
  SELECT * INTO link FROM public.omni_execution_connections WHERE project_id=_project FOR UPDATE;
  blocked := c.kill_switch IS DISTINCT FROM false OR
    coalesce((SELECT paused FROM public.automation_policy WHERE id=1),true);
  IF _op = 'connect' THEN
    expiry := (_a->>'expiresAt')::timestamptz;
    IF expiry IS NULL OR expiry<=now() OR expiry>now()+interval '24 hours' OR _approval IS NULL
      OR coalesce((SELECT paused FROM public.automation_policy WHERE id=1),true)
    THEN RAISE EXCEPTION 'Connection approval expired or Kill Switch engaged'; END IF;
    IF link.project_id IS NOT NULL AND link.operation_id=(_a->>'operationId')::uuid THEN
      IF link.approval_id IS DISTINCT FROM _approval OR link.expires_at IS DISTINCT FROM expiry
        OR NOT link.connected THEN RAISE EXCEPTION 'Operation identity conflict'; END IF;
    ELSE
      IF EXISTS (SELECT 1 FROM public.omni_execution_jobs WHERE project_id=_project AND state IN ('authorized','running','cancel_requested'))
      THEN RAISE EXCEPTION 'Reconcile active jobs before reconnecting'; END IF;
      INSERT INTO public.omni_execution_connections(project_id,owner_id,operation_id,approval_id,expires_at,connected)
        VALUES(_project,_owner,(_a->>'operationId')::uuid,_approval,expiry,true)
        ON CONFLICT(project_id) DO UPDATE SET owner_id=_owner,operation_id=excluded.operation_id,
          approval_id=_approval,expires_at=expiry,connected=true,configured=false,armed=false,
          verified_at=NULL,executor_release=NULL;
    END IF;
  ELSIF _op IN ('revoke','disarm','unconfigure') THEN
    UPDATE public.omni_execution_connections SET armed=false,
      connected=CASE WHEN _op='revoke' THEN false ELSE connected END,
      configured=CASE WHEN _op IN ('revoke','unconfigure') THEN false ELSE configured END WHERE project_id=_project;
    UPDATE public.omni_execution_jobs SET state='cancel_requested',cancel_delivered=false
      WHERE project_id=_project AND state IN ('authorized','running');
  ELSIF _op NOT IN ('safety','finish','permission') THEN
    IF link.connected IS DISTINCT FROM true OR link.approval_id IS DISTINCT FROM _approval
      OR link.owner_id IS DISTINCT FROM _owner OR link.expires_at<=now()
    THEN RAISE EXCEPTION 'Connection is not authorized'; END IF;
    IF _op='configure' THEN
      guard := public.code_total_spend_guard_status();
      meter := public.code_spend_meter_status();
      IF c.provider_hard_cap_verified IS DISTINCT FROM true
        OR coalesce((SELECT paused FROM public.automation_policy WHERE id=1),true)
        OR link.verified_at IS NULL OR link.verified_at<now()-interval '15 minutes'
        OR link.executor_release IS DISTINCT FROM _a->>'release'
        OR (guard->>'enforced')::boolean IS DISTINCT FROM true
        OR (meter->>'ok')::boolean IS DISTINCT FROM true
        OR c.daily_spend_limit_usd>5 OR (guard->>'limit_usd')::numeric>10
      THEN RAISE EXCEPTION 'CODE spend enforcement is not verified'; END IF;
      -- Configuration does not turn on CODE, arm OMNI, or release either Stop.
      UPDATE public.omni_execution_connections SET configured=true WHERE project_id=_project;
    ELSIF _op='verify' THEN
      IF coalesce(_a->>'release','') !~ '^[a-zA-Z0-9_.-]{1,80}$' OR (_a->>'passed')::boolean IS DISTINCT FROM true
      THEN RAISE EXCEPTION 'Executor verification failed'; END IF;
      UPDATE public.omni_execution_connections SET executor_release=_a->>'release',verified_at=now(),armed=false
        WHERE project_id=_project;
    ELSIF _op='arm' THEN
      IF blocked OR link.configured IS DISTINCT FROM true OR link.verified_at IS NULL OR link.executor_release IS NULL
        OR link.verified_at<now()-interval '15 minutes' OR link.executor_release IS DISTINCT FROM _a->>'release'
        OR c.enabled IS DISTINCT FROM true OR c.provider_hard_cap_verified IS DISTINCT FROM true
        OR (public.code_spend_meter_status()->>'ok')::boolean IS DISTINCT FROM true
        OR (public.code_total_spend_guard_status()->>'enforced')::boolean IS DISTINCT FROM true
      THEN RAISE EXCEPTION 'Execution is blocked; Stop is never released here'; END IF;
      UPDATE public.omni_execution_connections SET armed=true WHERE project_id=_project;
    ELSIF _op='authorize' THEN
      IF blocked OR link.armed IS DISTINCT FROM true OR link.configured IS DISTINCT FROM true OR c.enabled IS DISTINCT FROM true
        OR link.verified_at IS NULL OR link.verified_at<now()-interval '15 minutes' OR link.executor_release IS DISTINCT FROM _a->>'release'
      THEN RAISE EXCEPTION 'Autonomous execution is disabled'; END IF;
      expiry := (_a->>'expiresAt')::timestamptz;
      IF expiry IS NULL OR expiry<=now() OR expiry>least(link.expires_at,now()+interval '60 seconds')
        OR _a->>'planSha256' !~ '^[a-f0-9]{64}$'
      THEN RAISE EXCEPTION 'Plan authorization is invalid'; END IF;
      SELECT * INTO job FROM public.omni_execution_jobs WHERE id=(_a->>'jobId')::uuid FOR UPDATE;
      IF job.id IS NOT NULL THEN
        IF job.project_id IS DISTINCT FROM _project OR job.owner_id IS DISTINCT FROM _owner
          OR job.plan_sha256 IS DISTINCT FROM _a->>'planSha256' OR job.expires_at IS DISTINCT FROM expiry
        THEN RAISE EXCEPTION 'Job identity conflict'; END IF;
      ELSE
        IF EXISTS (SELECT 1 FROM public.omni_execution_jobs WHERE state IN ('authorized','running','cancel_requested'))
        THEN RAISE EXCEPTION 'Autonomous slot is occupied'; END IF;
        INSERT INTO public.omni_execution_jobs(id,project_id,owner_id,plan_sha256,expires_at)
          VALUES((_a->>'jobId')::uuid,_project,_owner,_a->>'planSha256',expiry);
      END IF;
    END IF;
  END IF;
  IF _op IN ('claim','permission','finish') THEN
    SELECT * INTO job FROM public.omni_execution_jobs WHERE id=(_a->>'jobId')::uuid FOR UPDATE;
    IF job.id IS NULL OR job.project_id IS DISTINCT FROM _project OR job.owner_id IS DISTINCT FROM _owner
      OR job.plan_sha256 IS DISTINCT FROM _a->>'planSha256'
    THEN RAISE EXCEPTION 'Job scope denied'; END IF;
    IF _op='finish' THEN
      IF _a->>'outcome' NOT IN ('completed','failed','cancelled') THEN RAISE EXCEPTION 'Invalid outcome'; END IF;
      UPDATE public.omni_execution_jobs SET state=CASE WHEN state='cancel_requested' THEN 'cancelled'
        ELSE _a->>'outcome' END,finished_at=now(),cancel_delivered=true
        WHERE id=job.id AND state IN ('running','cancel_requested');
    ELSE
      ok := coalesce(NOT blocked AND c.enabled IS TRUE AND link.connected IS TRUE AND link.configured IS TRUE
        AND link.armed IS TRUE AND link.approval_id=_approval AND link.expires_at>now()
        AND link.verified_at>now()-interval '15 minutes' AND job.expires_at>now()
        AND job.permit_id IS NOT NULL AND job.permit_expires_at>now()
        AND job.state=CASE WHEN _op='claim' THEN 'authorized' ELSE 'running' END
        AND (public.code_spend_meter_status()->>'ok')::boolean IS TRUE
        AND (public.code_total_spend_guard_status()->>'enforced')::boolean IS TRUE,false);
      IF ok AND _op='claim' THEN
        UPDATE public.omni_execution_jobs SET state='running',claimed_at=now() WHERE id=job.id;
      ELSIF NOT ok AND (job.state='authorized' OR (_op='permission' AND job.state='running')) THEN
        UPDATE public.omni_execution_jobs SET state='cancel_requested',cancel_delivered=false WHERE id=job.id;
      END IF;
    END IF;
  END IF;
  INSERT INTO public.audit_logs(actor,action,detail,outcome)
    VALUES(_owner,'omni.execution.'||_op,
      jsonb_build_object('project_id',_project,'job_id',_a->>'jobId'),CASE WHEN blocked THEN 'blocked' ELSE 'ok' END);
  SELECT * INTO link FROM public.omni_execution_connections WHERE project_id=_project;
  RETURN jsonb_build_object('allowed',ok,'checkedAt',now(),'projectId',_project,
    'jobState',(SELECT state FROM public.omni_execution_jobs WHERE id=(_a->>'jobId')::uuid),
    'connected',coalesce(link.connected,false) AND link.expires_at>now(),'configured',coalesce(link.configured,false),
    'armed',coalesce(link.armed,false),'codeEnabled',c.enabled,'emergencyStop',c.kill_switch,'killSwitch',
    coalesce((SELECT paused FROM public.automation_policy WHERE id=1),true),
    'executionReady',coalesce(NOT blocked AND c.enabled AND link.connected AND link.configured AND link.armed
      AND link.expires_at>now() AND link.verified_at>now()-interval '15 minutes'
      AND (public.code_spend_meter_status()->>'ok')::boolean IS TRUE
      AND (public.code_total_spend_guard_status()->>'enforced')::boolean IS TRUE,false),
    'expiresAt',link.expires_at,'operationId',link.operation_id,'executorRelease',link.executor_release,
    'running',EXISTS(SELECT 1 FROM public.omni_execution_jobs WHERE project_id=_project AND state='running'),
    'activePermits',(SELECT count(*) FROM public.omni_execution_jobs WHERE project_id=_project
      AND state IN ('authorized','running') AND permit_id IS NOT NULL AND permit_expires_at>now()),
    'cancellationPending',EXISTS(SELECT 1 FROM public.omni_execution_jobs WHERE project_id=_project AND state='cancel_requested'));
END $function$
;

CREATE FUNCTION public.omni_execution_control(_owner uuid, _project uuid, _approval uuid, _op text, _a jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  snapshot jsonb;
  job public.omni_execution_jobs%ROWTYPE;
  owner_authorization uuid;
  permit_live boolean;
BEGIN
  -- Match published 0067: global policy precedes CODE controls and job locks.
  PERFORM 1 FROM public.automation_policy WHERE id=1 FOR SHARE;
  PERFORM 1 FROM public.code_runtime_controls WHERE singleton FOR UPDATE;
  SELECT id INTO owner_authorization FROM public.omni_autonomy_authorizations
    WHERE client_id=_a->>'clientId' AND owner_id=_owner AND project_id=_project
      AND approval_id=_approval AND revoked_at IS NULL AND expires_at>clock_timestamp();
  IF _op IN ('configure','arm','authorize','lease') AND owner_authorization IS NULL
  THEN RAISE EXCEPTION 'Fresh Jackboy owner authorization required'; END IF;
  IF _op IN ('lease','claim','permission') THEN
    SELECT * INTO job FROM public.omni_execution_jobs WHERE id=(_a->>'jobId')::uuid FOR UPDATE;
    permit_live := owner_authorization IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.omni_execution_permits WHERE id=job.permit_id
        AND authorization_id=owner_authorization AND client_id=_a->>'clientId'
        AND project_id=_project AND approval_id=_approval AND job_id=job.id
        AND job_kind='autonomous' AND payload_digest=job.plan_sha256
        AND status='active' AND expires_at>clock_timestamp()
    );
  END IF;
  IF _op='lease' THEN
    snapshot := public.omni_execution_control_without_lease(_owner,_project,_approval,'safety','{}');
    IF (snapshot->>'executionReady')::boolean IS DISTINCT FROM true OR NOT EXISTS (
      SELECT 1 FROM public.omni_execution_connections WHERE project_id=_project
        AND owner_id=_owner AND approval_id=_approval AND expires_at>clock_timestamp()
    ) THEN RAISE EXCEPTION 'Mothership lease is not authorized'; END IF;
    SELECT * INTO job FROM public.omni_execution_jobs WHERE id=(_a->>'jobId')::uuid FOR UPDATE;
    IF job.id IS NULL OR job.project_id IS DISTINCT FROM _project OR job.owner_id IS DISTINCT FROM _owner
      OR job.plan_sha256 IS DISTINCT FROM _a->>'planSha256'
      OR job.state NOT IN ('authorized','running') OR job.expires_at<=clock_timestamp()
      OR permit_live IS DISTINCT FROM true OR job.permit_expires_at<=clock_timestamp()
      OR (job.mothership_lease_expires_at IS NOT NULL AND job.mothership_lease_expires_at<=clock_timestamp())
    THEN RAISE EXCEPTION 'Mothership lease expired or scope changed'; END IF;
    UPDATE public.omni_execution_jobs SET mothership_lease_expires_at=
      least(clock_timestamp()+interval '1 second',expires_at,permit_expires_at) WHERE id=job.id;
    INSERT INTO public.audit_logs(actor,action,detail,outcome)
      VALUES(_owner,'omni.execution.lease',jsonb_build_object('project_id',_project,'job_id',job.id),'ok');
    snapshot := snapshot || jsonb_build_object('allowed',true,'checkedAt',clock_timestamp());
  ELSE
  IF _op IN ('claim','permission') THEN
    IF job.owner_id=_owner AND job.project_id=_project AND job.plan_sha256=_a->>'planSha256'
      AND (permit_live IS DISTINCT FROM true
        OR job.mothership_lease_expires_at IS NULL OR job.mothership_lease_expires_at<=clock_timestamp())
    THEN
      UPDATE public.omni_execution_jobs SET state='cancel_requested',cancel_delivered=false
        WHERE id=job.id AND state IN ('authorized','running');
    END IF;
  END IF;
  snapshot := public.omni_execution_control_without_lease(_owner,_project,_approval,_op,_a);
  END IF;
  IF _op IN ('claim','permission') AND snapshot->>'allowed'='true' THEN
    UPDATE public.omni_execution_jobs SET last_permission_at=clock_timestamp()
      WHERE id=(_a->>'jobId')::uuid;
  END IF;
  snapshot := snapshot || jsonb_build_object(
    'running',EXISTS(SELECT 1 FROM public.omni_execution_jobs WHERE project_id=_project
      AND state='running' AND last_permission_at>clock_timestamp()-interval '1500 milliseconds'
      AND mothership_lease_expires_at>clock_timestamp() AND permit_expires_at>clock_timestamp()),
    'executionReady',coalesce((snapshot->>'executionReady')::boolean,false)
      AND NOT EXISTS(SELECT 1 FROM public.omni_execution_jobs WHERE project_id=_project AND state='running'
        AND (last_permission_at IS NULL OR last_permission_at<=clock_timestamp()-interval '1500 milliseconds'
          OR mothership_lease_expires_at<=clock_timestamp() OR permit_expires_at<=clock_timestamp())));
  IF owner_authorization IS NULL THEN
    snapshot := snapshot || jsonb_build_object('executionReady',false,'allowed',false);
  END IF;
  RETURN snapshot;
END $function$
;

CREATE FUNCTION public.omni_execution_cancel_ack(_job uuid, _hash text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE job public.omni_execution_jobs%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.code_runtime_controls WHERE singleton FOR UPDATE;
  SELECT * INTO job FROM public.omni_execution_jobs WHERE id=_job FOR UPDATE;
  IF job.id IS NULL OR job.plan_sha256 IS DISTINCT FROM _hash
    OR job.state NOT IN ('cancel_requested','cancelled')
  THEN RAISE EXCEPTION 'Cancellation acknowledgement scope denied'; END IF;
  IF job.state='cancelled' THEN RETURN; END IF;
  UPDATE public.omni_execution_jobs SET state='cancelled',cancel_delivered=true,finished_at=now()
    WHERE id=_job;
  INSERT INTO public.audit_logs(actor,action,detail,outcome)
    VALUES(job.owner_id,'omni.execution.cancel_ack',jsonb_build_object('job_id',_job),'ok');
END $function$
;

CREATE FUNCTION public.omni_execution_permit_action_unlocked(_op text, _a jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  client text := _a->>'clientId';
  project uuid := (_a->>'projectId')::uuid;
  approval uuid := (_a->>'approvalId')::uuid;
  owner_id uuid := (_a->>'ownerId')::uuid;
  expiry timestamptz := (_a->>'approvalExpiresAt')::timestamptz;
  job uuid := NULLIF(_a->>'jobId', '')::uuid;
  kind text := _a->>'kind';
  dig text := _a->>'digest';
  estimate numeric := NULLIF(_a->>'estimateUsd', '')::numeric;
  auth public.omni_autonomy_authorizations;
  p public.omni_execution_permits;
  controls public.code_runtime_controls;
  paused boolean;
  reason text;
  spent numeric;
  day_start timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  IF _op IS NULL OR _op NOT IN ('request', 'release', 'safety') THEN RAISE EXCEPTION 'invalid operation'; END IF;
  IF client IS NULL OR client !~ '^[a-zA-Z0-9_-]{1,64}$' THEN RAISE EXCEPTION 'invalid client'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('omni-permit:' || client, 0));

  IF NOT EXISTS (SELECT 1 FROM public.omni_link_sessions WHERE token_hash = _a->>'tokenHash'
      AND client_id = client AND project_id = project AND approval_id = approval AND expires_at > now()) THEN
    RETURN jsonb_build_object('http', 401, 'error', 'session_expired_or_invalid');
  END IF;
  INSERT INTO public.omni_callback_nonces(nonce) VALUES ('permit-v1:' || client || ':' || (_a->>'nonce')) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('http', 409, 'error', 'replay'); END IF;

  -- Lapsed permits never come back: a job whose permit expired must stop and start again.
  UPDATE public.omni_execution_permits SET status = 'expired', closed_at = now(), closed_reason = 'not_renewed_in_time'
    WHERE client_id = client AND status = 'active' AND expires_at <= now();

  SELECT ap.paused INTO paused FROM public.automation_policy AS ap WHERE ap.id = 1;
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true;
  SELECT * INTO auth FROM public.omni_autonomy_authorizations
    WHERE client_id = client AND project_id = project AND approval_id = approval
      AND revoked_at IS NULL AND expires_at > now();

  reason := CASE
    WHEN expiry IS NULL OR expiry <= now() OR expiry > now() + interval '24 hours' THEN 'approval_expired'
    WHEN NOT EXISTS (SELECT 1 FROM public.owner_projects WHERE id = project AND created_by = owner_id AND active)
      OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = owner_id AND role = 'owner') THEN 'owner_scope'
    WHEN COALESCE(paused, true) THEN 'kill_switch_on'
    WHEN controls.singleton IS DISTINCT FROM true OR controls.kill_switch THEN 'emergency_stop_engaged'
    WHEN NOT controls.enabled THEN 'code_disabled'
    WHEN auth.id IS NULL THEN 'not_authorized'
    ELSE NULL END;

  IF _op = 'safety' THEN
    RETURN jsonb_build_object('http', 200, 'safety', jsonb_build_object(
      'checkedAt', now(), 'validUntil', now() + interval '30 seconds',
      'killSwitch', COALESCE(paused, true),
      'emergencyStop', controls.singleton IS DISTINCT FROM true OR controls.kill_switch,
      'codeEnabled', controls.singleton IS NOT DISTINCT FROM true AND controls.enabled,
      'authorization', CASE WHEN auth.id IS NULL THEN NULL ELSE jsonb_build_object('id', auth.id, 'expiresAt', auth.expires_at) END,
      'autonomousAllowed', reason IS NULL,
      'blockedBy', reason,
      'manualDiagnosticsAllowed', NOT COALESCE(paused, true),
      'activePermits', (SELECT count(*) FROM public.omni_execution_permits WHERE client_id = client AND status = 'active')));
  END IF;

  IF job IS NULL THEN RETURN jsonb_build_object('http', 400, 'error', 'job_required'); END IF;
  SELECT * INTO p FROM public.omni_execution_permits WHERE client_id = client AND job_id = job FOR UPDATE;

  IF _op = 'release' THEN
    IF p.id IS NULL THEN RETURN jsonb_build_object('http', 404, 'error', 'permit_not_found'); END IF;
    IF p.status = 'active' THEN
      UPDATE public.omni_execution_permits SET status = 'released', closed_at = now(), closed_reason = 'released_by_omni'
        WHERE id = p.id RETURNING * INTO p;
      INSERT INTO public.audit_logs(actor, action, detail, outcome)
        VALUES (NULL, 'omni.permit_released', jsonb_build_object('permit', p.id, 'job', job), 'ok');
    END IF;
    RETURN jsonb_build_object('http', 200, 'permit', jsonb_build_object('id', p.id, 'jobId', p.job_id, 'status', p.status));
  END IF;

  -- request
  IF reason IS NULL AND (kind IS NULL OR kind NOT IN ('autonomous', 'code') OR dig IS NULL OR dig !~ '^[a-f0-9]{64}$'
      OR estimate IS NULL OR estimate <= 0 OR estimate > auth.per_task_reserve_usd) THEN reason := 'scope_invalid'; END IF;
  IF reason IS NULL AND p.id IS NOT NULL THEN
    IF p.status = 'expired' THEN reason := 'permit_lapsed';
    ELSIF p.status <> 'active' THEN reason := 'job_closed';
    ELSIF p.job_kind <> kind OR p.payload_digest <> dig OR p.authorization_id <> auth.id THEN reason := 'scope_mismatch';
    END IF;
  END IF;
  IF reason IS NULL AND p.id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.omni_execution_permits WHERE client_id = client AND status = 'active') THEN
      reason := 'concurrency_limit';
    ELSE
      SELECT COALESCE(sum(reserved_usd), 0) INTO spent FROM public.omni_execution_permits
        WHERE client_id = client AND issued_at >= day_start;
      IF spent + auth.per_task_reserve_usd > auth.daily_limit_usd THEN reason := 'daily_limit'; END IF;
    END IF;
  END IF;

  IF reason IS NOT NULL THEN
    IF p.id IS NOT NULL AND p.status = 'active' THEN
      UPDATE public.omni_execution_permits SET status = 'revoked', closed_at = now(), closed_reason = reason
        WHERE id = p.id RETURNING * INTO p;
    END IF;
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (NULL, 'omni.permit_refused', jsonb_build_object('job', job, 'reason', reason, 'permit', p.id), 'refused');
    RETURN jsonb_build_object('http', 403, 'error', 'permit_denied', 'reason', reason,
      'permit', CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id', p.id, 'jobId', p.job_id, 'status', p.status) END);
  END IF;

  IF p.id IS NULL THEN
    INSERT INTO public.omni_execution_permits(authorization_id, client_id, project_id, approval_id, job_id, job_kind,
        payload_digest, reserved_usd, status, expires_at)
      VALUES (auth.id, client, project, approval, job, kind, dig, auth.per_task_reserve_usd, 'active',
        least(now() + interval '60 seconds', auth.expires_at, expiry))
      RETURNING * INTO p;
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (NULL, 'omni.permit_issued', jsonb_build_object('permit', p.id, 'job', job, 'kind', kind,
        'reserved_usd', p.reserved_usd, 'expires_at', p.expires_at), 'ok');
  ELSE
    UPDATE public.omni_execution_permits SET renewed_at = now(), renewals = renewals + 1,
        expires_at = least(now() + interval '60 seconds', auth.expires_at, expiry)
      WHERE id = p.id RETURNING * INTO p;
  END IF;
  RETURN jsonb_build_object('http', 200, 'permit', jsonb_build_object(
    'id', p.id, 'jobId', p.job_id, 'kind', p.job_kind, 'digest', p.payload_digest, 'status', p.status,
    'issuedAt', p.issued_at, 'expiresAt', p.expires_at, 'renewals', p.renewals,
    'limits', jsonb_build_object('perCallUsd', auth.per_call_limit_usd, 'perTaskUsd', auth.per_task_reserve_usd,
      'dailyUsd', auth.daily_limit_usd)));
END $function$
;

CREATE FUNCTION public.omni_execution_permit_action_without_worker(_op text, _a jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- Acquire before the inner function takes its client advisory lock and permit row locks.
  PERFORM 1 FROM public.automation_policy WHERE id = 1 FOR SHARE;
  PERFORM 1 FROM public.code_runtime_controls WHERE singleton = true FOR SHARE;
  RETURN public.omni_execution_permit_action_unlocked(_op, _a);
END $function$
;

CREATE FUNCTION public.omni_execution_permit_action_without_safety_generation(_op text, _a jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  job public.omni_execution_jobs%ROWTYPE;
  permit public.omni_execution_permits%ROWTYPE;
  snapshot jsonb;
  result jsonb;
BEGIN
  PERFORM 1 FROM public.automation_policy WHERE id=1 FOR SHARE;
  PERFORM 1 FROM public.code_runtime_controls WHERE singleton FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('omni-permit:'||(_a->>'clientId'),0));
  SELECT * INTO job FROM public.omni_execution_jobs WHERE id=NULLIF(_a->>'jobId','')::uuid FOR UPDATE;
  IF _op='request' AND job.id IS NOT NULL THEN
    snapshot := public.omni_execution_control(
      (_a->>'ownerId')::uuid,(_a->>'projectId')::uuid,(_a->>'approvalId')::uuid,
      'safety',jsonb_build_object('clientId',_a->>'clientId'));
    IF job.project_id IS DISTINCT FROM (_a->>'projectId')::uuid
      OR job.owner_id IS DISTINCT FROM (_a->>'ownerId')::uuid
      OR job.plan_sha256 IS DISTINCT FROM _a->>'digest' OR _a->>'kind' IS DISTINCT FROM 'autonomous'
      OR job.state NOT IN ('authorized','running') OR job.expires_at<=clock_timestamp()
      OR (job.permit_id IS NOT NULL AND job.permit_expires_at<=clock_timestamp())
      OR (snapshot->>'executionReady')::boolean IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'Bounded permit scope or readiness denied'; END IF;
  END IF;
  result := public.omni_execution_permit_action_without_worker(_op,_a);
  IF _op='request' AND job.id IS NOT NULL AND result->>'http'='200' THEN
    UPDATE public.omni_execution_permits
      SET expires_at=least(expires_at,job.expires_at)
      WHERE id=(result->'permit'->>'id')::uuid RETURNING * INTO permit;
    UPDATE public.omni_execution_jobs
      SET permit_id=permit.id,permit_issued_at=permit.issued_at,
        permit_expires_at=permit.expires_at,permit_renewals=permit.renewals WHERE id=job.id;
    result := jsonb_set(result,'{permit,expiresAt}',to_jsonb(permit.expires_at));
  END IF;
  RETURN result;
END $function$
;

CREATE FUNCTION public.omni_execution_permit_action_without_owner_scope(_op text, _a jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  result jsonb;
  reason text;
  permit public.omni_execution_permits%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.automation_policy WHERE id=1 FOR SHARE;
  PERFORM 1 FROM public.code_runtime_controls WHERE singleton FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('omni-permit:'||(_a->>'clientId'),0));
  IF (public.code_spend_meter_status()->>'ok')::boolean IS DISTINCT FROM true THEN
    reason := 'meter_untrusted';
  ELSIF public.code_total_spend_guard_enforced() IS DISTINCT FROM true THEN
    reason := 'gateway_unenforced';
  END IF;
  IF _op='request' THEN
    SELECT * INTO permit FROM public.omni_execution_permits
      WHERE client_id=_a->>'clientId' AND job_id=(_a->>'jobId')::uuid FOR UPDATE;
    IF permit.id IS NOT NULL AND permit.status='active' AND permit.stop_generation IS DISTINCT FROM
        (SELECT generation FROM public.omni_permit_safety_generation WHERE singleton)
    THEN reason := 'permit_stopped'; END IF;
  END IF;
  -- The installed authority still validates the live session and consumes the nonce on refusal.
  result := public.omni_execution_permit_action_without_safety_generation(
    CASE WHEN _op='request' AND reason IS NOT NULL THEN 'safety' ELSE _op END,_a);
  IF result->>'http'='200' AND _op='request' AND reason IS NOT NULL THEN
    IF result->'safety'->>'blockedBy' IN (
      'kill_switch_on','emergency_stop_engaged','code_disabled','approval_expired','owner_scope','not_authorized')
    THEN reason := result->'safety'->>'blockedBy'; END IF;
    IF permit.id IS NOT NULL AND permit.status='active' THEN
      UPDATE public.omni_execution_permits SET status='revoked',closed_at=now(),closed_reason=reason
        WHERE id=permit.id RETURNING * INTO permit;
    END IF;
    INSERT INTO public.audit_logs(actor,action,detail,outcome)
      VALUES(NULL,'omni.permit_refused',jsonb_build_object('job',_a->>'jobId','reason',reason),'refused');
    RETURN jsonb_build_object('http',403,'error','permit_denied','reason',reason,
      'permit',CASE WHEN permit.id IS NULL THEN NULL ELSE
        jsonb_build_object('id',permit.id,'jobId',permit.job_id,'status',permit.status) END);
  END IF;
  IF _op='safety' AND result->'safety'->>'autonomousAllowed'='true' AND reason IS NOT NULL THEN
    result := jsonb_set(result,'{safety,autonomousAllowed}','false'::jsonb);
    result := jsonb_set(result,'{safety,blockedBy}',to_jsonb(reason));
  END IF;
  RETURN result;
END $function$
;

CREATE FUNCTION public.omni_execution_permit_action(_op text, _a jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  auth public.omni_autonomy_authorizations;
  permit public.omni_execution_permits;
  reason text;
  result jsonb;
BEGIN
  -- Same lock order as 0067/0070: global policy, CODE controls, then the per-client permit lock.
  PERFORM 1 FROM public.automation_policy WHERE id = 1 FOR SHARE;
  PERFORM 1 FROM public.code_runtime_controls WHERE singleton FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('omni-permit:' || (_a->>'clientId'), 0));
  IF _op IN ('request', 'safety') THEN
    SELECT * INTO auth FROM public.omni_autonomy_authorizations
      WHERE client_id = _a->>'clientId' AND project_id = (_a->>'projectId')::uuid
        AND approval_id = (_a->>'approvalId')::uuid AND revoked_at IS NULL AND expires_at > now();
    IF auth.id IS NOT NULL AND auth.owner_id IS DISTINCT FROM (_a->>'ownerId')::uuid THEN
      reason := 'owner_scope';
    ELSIF _op = 'request' AND auth.id IS NOT NULL AND _a->>'kind' IN ('autonomous', 'code')
      AND NOT (_a->>'kind' = ANY (auth.capabilities)) THEN
      reason := 'capability_not_authorized';
    END IF;
  END IF;

  -- On refusal the installed authority still validates the session and consumes the nonce.
  result := public.omni_execution_permit_action_without_owner_scope(
    CASE WHEN _op = 'request' AND reason IS NOT NULL THEN 'safety' ELSE _op END, _a);
  IF result->>'http' = '200' AND _op = 'request' AND reason IS NOT NULL THEN
    IF result->'safety'->>'blockedBy' IN (
      'kill_switch_on','emergency_stop_engaged','code_disabled','approval_expired','owner_scope','not_authorized',
      'meter_untrusted','gateway_unenforced')
    THEN reason := result->'safety'->>'blockedBy'; END IF;
    SELECT * INTO permit FROM public.omni_execution_permits
      WHERE client_id = _a->>'clientId' AND job_id = NULLIF(_a->>'jobId', '')::uuid FOR UPDATE;
    IF permit.id IS NOT NULL AND permit.status = 'active' THEN
      UPDATE public.omni_execution_permits SET status = 'revoked', closed_at = now(), closed_reason = reason
        WHERE id = permit.id RETURNING * INTO permit;
    END IF;
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (NULL, 'omni.permit_refused', jsonb_build_object('job', _a->>'jobId', 'kind', _a->>'kind',
        'reason', reason, 'permit', permit.id), 'refused');
    RETURN jsonb_build_object('http', 403, 'error', 'permit_denied', 'reason', reason,
      'permit', CASE WHEN permit.id IS NULL THEN NULL ELSE
        jsonb_build_object('id', permit.id, 'jobId', permit.job_id, 'status', permit.status) END);
  END IF;
  IF _op = 'safety' AND result->>'http' = '200' THEN
    IF reason IS NOT NULL AND result->'safety'->>'autonomousAllowed' = 'true' THEN
      result := jsonb_set(result, '{safety,autonomousAllowed}', 'false'::jsonb);
      result := jsonb_set(result, '{safety,blockedBy}', to_jsonb(reason));
    END IF;
    IF auth.id IS NOT NULL AND reason IS NULL AND jsonb_typeof(result->'safety'->'authorization') = 'object' THEN
      result := jsonb_set(result, '{safety,authorization,capabilities}', to_jsonb(auth.capabilities));
    END IF;
  END IF;
  RETURN result;
END $function$
;

CREATE FUNCTION public.omni_execution_permit_closed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM 'active' THEN
    UPDATE public.omni_execution_jobs SET state='cancel_requested',cancel_delivered=false
      WHERE permit_id=NEW.id AND state IN ('authorized','running');
  END IF;
  RETURN NEW;
END $function$
;

CREATE FUNCTION public.omni_execution_stop_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF TG_TABLE_NAME='automation_policy' THEN
    PERFORM 1 FROM public.code_runtime_controls WHERE singleton FOR UPDATE;
  END IF;
  IF (TG_TABLE_NAME='code_runtime_controls' AND (
      (to_jsonb(NEW)->>'kill_switch')::boolean IS DISTINCT FROM false
      OR (to_jsonb(NEW)->>'enabled')::boolean IS DISTINCT FROM true))
    OR (TG_TABLE_NAME='automation_policy' AND (to_jsonb(NEW)->>'paused')::boolean IS DISTINCT FROM false)
  THEN
    UPDATE public.omni_execution_connections SET armed=false;
    UPDATE public.omni_execution_jobs SET state='cancel_requested',cancel_delivered=false
      WHERE state IN ('authorized','running');
  END IF;
  RETURN NEW;
END $function$
;

CREATE FUNCTION public.omni_permit_generation_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF TG_TABLE_NAME='omni_execution_permits' THEN
    SELECT generation INTO STRICT NEW.stop_generation
      FROM public.omni_permit_safety_generation WHERE singleton;
  ELSIF (TG_TABLE_NAME='automation_policy' AND
      (to_jsonb(NEW)->>'paused')::boolean IS TRUE AND (to_jsonb(OLD)->>'paused')::boolean IS DISTINCT FROM true)
    OR (TG_TABLE_NAME='code_runtime_controls' AND (
      ((to_jsonb(NEW)->>'kill_switch')::boolean IS TRUE AND (to_jsonb(OLD)->>'kill_switch')::boolean IS DISTINCT FROM true)
      OR ((to_jsonb(NEW)->>'enabled')::boolean IS FALSE AND (to_jsonb(OLD)->>'enabled')::boolean IS TRUE)))
  THEN
    -- Independent of the installed best-effort permit-revocation subtransaction.
    UPDATE public.omni_permit_safety_generation SET generation=generation+1 WHERE singleton;
  END IF;
  RETURN NEW;
END $function$
;

CREATE FUNCTION public.omni_permits_revoke_on_stop()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  why text;
  n int := 0;
BEGIN
  IF TG_TABLE_NAME = 'automation_policy' THEN
    IF NEW.paused IS TRUE AND OLD.paused IS DISTINCT FROM true THEN why := 'kill_switch_on'; END IF;
  ELSIF NEW.kill_switch IS TRUE AND OLD.kill_switch IS DISTINCT FROM true THEN why := 'emergency_stop_engaged';
  ELSIF NEW.enabled IS FALSE AND OLD.enabled IS TRUE THEN why := 'code_disabled';
  END IF;
  IF why IS NULL THEN RETURN NEW; END IF;
  BEGIN
    UPDATE public.omni_execution_permits SET status = 'revoked', closed_at = now(), closed_reason = why
      WHERE status = 'active';
    GET DIAGNOSTICS n = ROW_COUNT;
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (NULL, 'omni.permits_revoked', jsonb_build_object('reason', why, 'count', n), 'ok');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END $function$
;

COMMIT;

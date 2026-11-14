-- DRAFT — NOT INSTALLED. Needs a separate, specific owner approval before it is applied to production.
-- Independent CODE safety controls.
--
-- Today the System Kill Switch, the CODE enabled setting and the CODE Emergency Stop are coupled:
-- enable_code_runtime turns CODE on AND releases the Emergency Stop in one step, engaging the stop
-- always turns CODE off, and the Kill Switch has to engage the CODE stop because CODE admission
-- checks the stop, not the Kill Switch.
--
-- After this change each control has its own owner-only, audited database action and changing one
-- never writes the other two:
--   * set_code_enabled(actor, bool)       -> only code_runtime_controls.enabled
--   * engage_code_kill_switch(actor)      -> only the Emergency Stop (kill_switch) + cancellation bookkeeping
--   * release_code_emergency_stop(actor)  -> only the Emergency Stop, refused while any emergency protection holds
--   * set_automation_policy (unchanged)   -> only the System Kill Switch (automation_policy.paused)
-- CODE admission (claim_code_runtime_slot, admit_code_provider_call, dispatch_code_provider_call) now
-- also refuses while the System Kill Switch is on, so execution is blocked whenever the Kill Switch is
-- on, the Emergency Stop is engaged, CODE is disabled, or any existing allowlist/meter/budget check fails.
-- Those three functions are the live definitions with exactly one added line each; the $1/task,
-- $5/day and $10 total checks are unchanged.
-- Automatic safety trips (two-failure stop, $10 total cap trip, spend-spike pause) are unchanged and may
-- still turn CODE off as well as engaging the stop.
-- code_independent_controls_installed() lets the app detect this change; until it reports true the app
-- keeps the old behaviour (Kill Switch ON also engages the CODE stop) so nothing is ever less safe.

-- Activation trigger: same rule, error text names the new owner actions.
CREATE OR REPLACE FUNCTION public.code_runtime_controls_activation_gate()
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
$function$;

-- CODE admission: live definitions plus one line that refuses while the System Kill Switch is on.
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
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  SELECT * INTO request_row FROM public.action_requests WHERE id = p_request_id FOR UPDATE;
  SELECT coalesce(sum(cost_usd), 0)
    INTO current_spend
    FROM public.code_usage_events
    WHERE occurred_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  SELECT coalesce(sum(cost_usd), 0)
    INTO hourly_spend
    FROM public.code_usage_events
    WHERE occurred_at >= now() - interval '1 hour';
  SELECT coalesce(sum(reserved_usd), 0)
    INTO held_spend
    FROM public.code_spend_reservations
    WHERE status <> 'settled';
  total_committed := public.code_total_spend_committed();

  IF controls.singleton IS DISTINCT FROM true
    OR controls.enabled IS DISTINCT FROM true
    OR controls.kill_switch IS DISTINCT FROM false
    OR NOT EXISTS (SELECT 1 FROM public.automation_policy WHERE id = 1 AND paused = false)
    OR controls.active_request_id IS NOT NULL
    OR controls.consecutive_failures >= 2
    OR controls.usage_spike
    OR NOT controls.provider_hard_cap_verified
    OR controls.provider_usage_at IS NULL
    OR controls.provider_usage_at < now() - interval '5 minutes'
    OR controls.provider_usage_at > now() + interval '30 seconds'
    OR current_spend >= controls.daily_spend_limit_usd
    OR hourly_spend >= controls.daily_spend_limit_usd * 0.5
    OR current_spend + held_spend + controls.per_task_reserve_usd > controls.daily_spend_limit_usd
    OR controls.total_spend_limit_usd IS NULL
    OR total_committed IS NULL
    OR total_committed + controls.per_task_reserve_usd > controls.total_spend_limit_usd
    OR NOT public.code_total_spend_guard_enforced()
    OR (request_row.resources->>'acceptance' = 'true'
      AND public.code_acceptance_guard_status() IS DISTINCT FROM true)
    OR p_repository IS NULL
    OR p_ref IS NULL
    OR p_workflow_sha IS NULL
    OR controls.allowed_targets->p_repository->>'ref' IS DISTINCT FROM p_ref
    OR controls.allowed_targets->p_repository->>'workflowSha' IS DISTINCT FROM p_workflow_sha
    OR request_row.id IS NULL
    OR request_row.status <> 'allowed'
    OR request_row.runner_claimed_at IS NULL
    OR request_row.runner_run_id <> p_run_id
    OR request_row.resources->>'repo' IS DISTINCT FROM p_repository
    OR request_row.resources->>'ref' IS DISTINCT FROM p_ref
    OR request_row.resources->>'workflowSha' IS DISTINCT FROM p_workflow_sha
    OR EXISTS (SELECT 1 FROM public.code_spend_reservations WHERE request_id = p_request_id)
  THEN
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (request_row.requested_by, 'code.task_blocked',
      jsonb_build_object('request', p_request_id, 'repo', p_repository,
        'total_committed_usd', total_committed, 'total_limit_usd', controls.total_spend_limit_usd),
      'blocked');
    RETURN false;
  END IF;

  INSERT INTO public.code_spend_reservations(request_id, run_id, reserved_usd)
    VALUES (p_request_id, p_run_id, controls.per_task_reserve_usd);
  UPDATE public.code_runtime_controls
    SET active_request_id = p_request_id,
        active_run_id = p_run_id,
        updated_at = now()
    WHERE singleton = true;
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (request_row.requested_by, 'code.task_started', jsonb_build_object('request', p_request_id, 'repo', p_repository, 'run_id', p_run_id, 'reserved_usd', controls.per_task_reserve_usd, 'total_committed_usd', total_committed + controls.per_task_reserve_usd), 'ok');
  RETURN true;
END;
$function$;

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
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  IF controls.enabled IS DISTINCT FROM true
    OR controls.kill_switch IS DISTINCT FROM false
    OR NOT EXISTS (SELECT 1 FROM public.automation_policy WHERE id = 1 AND paused = false)
    OR controls.stop_requested_at IS NOT NULL
    OR controls.cancellation_status IS DISTINCT FROM 'not_needed'
    OR controls.active_request_id IS DISTINCT FROM p_request_id
    OR controls.active_run_id IS DISTINCT FROM p_run_id
  THEN
    RAISE EXCEPTION 'CODE provider call blocked: runtime is not authorised for this task';
  END IF;
  IF controls.total_spend_limit_usd IS NULL
    OR public.code_total_spend_committed() > controls.total_spend_limit_usd
    OR NOT public.code_total_spend_guard_enforced()
  THEN
    RAISE EXCEPTION 'CODE provider call blocked: cumulative spending limit reached or guard not intact';
  END IF;
  SELECT * INTO reservation FROM public.code_spend_reservations
    WHERE request_id = p_request_id AND run_id = p_run_id FOR UPDATE;
  IF NOT FOUND OR reservation.status <> 'reserved' THEN
    RAISE EXCEPTION 'CODE provider call blocked: no active spend reservation';
  END IF;
  SELECT requested_by INTO owner_id FROM public.action_requests WHERE id = p_request_id;
  IF owner_id IS NULL
    OR p_ceiling_usd IS NULL OR p_ceiling_usd <= 0
    OR p_model IS NULL OR length(p_model) NOT BETWEEN 1 AND 100
    OR p_call_key IS NULL OR p_call_key !~ '^[A-Za-z0-9_-]{8,64}$'
  THEN
    RAISE EXCEPTION 'CODE provider call blocked: invalid request';
  END IF;
  IF (SELECT count(*) FROM public.code_provider_calls WHERE request_id = p_request_id) >= 500 THEN
    RAISE EXCEPTION 'CODE provider call blocked: call count limit reached';
  END IF;
  IF public.code_provider_call_holds(p_request_id) + p_ceiling_usd > reservation.reserved_usd THEN
    RAISE EXCEPTION 'CODE provider call blocked: task spending reservation would be exceeded';
  END IF;
  INSERT INTO public.code_provider_calls(request_id, run_id, call_key, model, ceiling_usd)
    VALUES (p_request_id, p_run_id, p_call_key, p_model, p_ceiling_usd)
    RETURNING id INTO call_id;
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (owner_id, 'code.provider_call_admitted',
      jsonb_build_object('call_id', call_id, 'request_id', p_request_id, 'model', p_model,
        'ceiling_usd', p_ceiling_usd), 'admitted');
  RETURN call_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.dispatch_code_provider_call(p_call_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  controls public.code_runtime_controls%ROWTYPE;
  call_row public.code_provider_calls%ROWTYPE;
BEGIN
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  SELECT * INTO call_row FROM public.code_provider_calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND OR call_row.status <> 'admitted'
    OR controls.enabled IS DISTINCT FROM true
    OR controls.kill_switch IS DISTINCT FROM false
    OR NOT EXISTS (SELECT 1 FROM public.automation_policy WHERE id = 1 AND paused = false)
    OR controls.stop_requested_at IS NOT NULL
    OR controls.cancellation_status IS DISTINCT FROM 'not_needed'
    OR controls.active_request_id IS DISTINCT FROM call_row.request_id
    OR controls.active_run_id IS DISTINCT FROM call_row.run_id
  THEN
    RAISE EXCEPTION 'CODE provider call dispatch blocked';
  END IF;
  UPDATE public.code_provider_calls SET status = 'dispatched', dispatched_at = now() WHERE id = p_call_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.engage_code_kill_switch(p_actor uuid)
 RETURNS TABLE(active_request_id uuid, active_run_id bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  active_request uuid;
  active_run bigint;
  code_enabled boolean;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only the owner can engage the CODE emergency stop';
  END IF;
  SELECT controls.active_request_id, controls.active_run_id, controls.enabled
    INTO active_request, active_run, code_enabled
    FROM public.code_runtime_controls AS controls
    WHERE controls.singleton = true
    FOR UPDATE;
  -- Only the Emergency Stop and its cancellation bookkeeping change; the CODE enabled setting is kept.
  UPDATE public.code_runtime_controls
    SET kill_switch = true,
        paused_reason = 'Owner engaged the CODE Emergency Stop',
        stop_requested_at = now(),
        cancellation_status = CASE
          WHEN active_request IS NULL OR active_run IS NULL THEN 'not_needed'
          ELSE 'pending' END,
        updated_at = now()
    WHERE singleton = true;
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (p_actor, 'code.emergency_stop', jsonb_build_object('active_request_id', active_request,
      'active_run_id', active_run, 'code_enabled_unchanged', code_enabled), 'ok');
  RETURN QUERY SELECT active_request, active_run;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_code_enabled(p_actor uuid, p_enabled boolean)
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
$function$;

CREATE OR REPLACE FUNCTION public.release_code_emergency_stop(p_actor uuid)
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
$function$;

-- The old combined path no longer releases the Emergency Stop; it only turns CODE on with every check.
CREATE OR REPLACE FUNCTION public.enable_code_runtime(p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  RETURN public.set_code_enabled(p_actor, true);
END;
$function$;
COMMENT ON FUNCTION public.enable_code_runtime(uuid) IS
  'DEPRECATED: replaced by set_code_enabled; it no longer releases the CODE Emergency Stop.';

-- True only when every CODE admission function refuses while the System Kill Switch is on.
CREATE OR REPLACE FUNCTION public.code_independent_controls_installed()
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
$function$;

REVOKE ALL ON FUNCTION public.set_code_enabled(uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_code_emergency_stop(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.code_independent_controls_installed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.engage_code_kill_switch(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enable_code_runtime(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_code_enabled(uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_code_emergency_stop(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.code_independent_controls_installed() TO service_role;
GRANT EXECUTE ON FUNCTION public.engage_code_kill_switch(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.enable_code_runtime(uuid) TO service_role;

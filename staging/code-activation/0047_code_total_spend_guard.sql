-- PROPOSED, NOT APPLIED. Requires explicit owner approval before it is run against any database.
--
-- CODE cumulative ($10 total) spend guard. Fail closed by construction:
--   committed = every spend reservation ever made (reserved, finished AND settled; settled holds are
--               deliberately still counted, so nothing is ever refunded against the total)
--             + every provider cost ever recorded (code_usage_events, all time)
--             + any gateway-recorded provider spend above its task reservation (overruns).
--   committed may never exceed total_spend_limit_usd (default and maximum 10.00 USD).
--
-- Enforcement points:
--   * claim_code_runtime_slot refuses a task unless committed + per_task_reserve_usd <= limit and the
--     guard is intact;
--   * admit_code_provider_call refuses every provider call when committed > limit or the guard is not
--     intact;
--   * an AFTER trigger on code_spend_reservations rejects any new 'reserved' hold that would push the
--     total over the limit, whatever code path inserts it;
--   * AFTER triggers on code_usage_events, code_provider_calls and code_spend_reservations engage the
--     Emergency Stop (kill_switch = true, enabled = false) when recorded spending already exceeds the
--     limit. Recorded spending is never rejected: it already happened and must stay on the books.
--
-- This migration does NOT touch provider_hard_cap_verified or its 0037 CHECK, never sets
-- enabled = true and never releases the kill switch. CODE stays blocked after applying it.

ALTER TABLE public.code_runtime_controls
  ADD COLUMN total_spend_limit_usd numeric(10,2) NOT NULL DEFAULT 10.00
    CONSTRAINT code_runtime_controls_total_spend_limit_usd_check
    CHECK (total_spend_limit_usd > 0 AND total_spend_limit_usd <= 10.00);

COMMENT ON COLUMN public.code_runtime_controls.total_spend_limit_usd IS
  'Cumulative CODE spend ceiling (all reservations + all recorded provider costs + overruns). Max 10.00 USD.';

CREATE FUNCTION public.code_total_spend_committed()
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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
$$;

-- Reports whether every enforcement point is installed and active. Fails closed on anything missing.
CREATE FUNCTION public.code_total_spend_guard_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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
$$;

CREATE FUNCTION public.code_total_spend_guard_enforced()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((public.code_total_spend_guard_status()->>'enforced')::boolean, false);
$$;

CREATE FUNCTION public.code_total_spend_guard_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
$$;

CREATE TRIGGER code_spend_reservations_total_guard
  AFTER INSERT ON public.code_spend_reservations
  FOR EACH ROW EXECUTE FUNCTION public.code_total_spend_guard_trigger();
CREATE TRIGGER code_usage_events_total_guard
  AFTER INSERT OR UPDATE ON public.code_usage_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.code_total_spend_guard_trigger();
CREATE TRIGGER code_provider_calls_total_guard
  AFTER INSERT OR UPDATE ON public.code_provider_calls
  FOR EACH STATEMENT EXECUTE FUNCTION public.code_total_spend_guard_trigger();

-- Same as the applied 0041 definition, plus the cumulative guard conditions.
CREATE OR REPLACE FUNCTION public.claim_code_runtime_slot(
  p_request_id uuid,
  p_repository text,
  p_ref text,
  p_workflow_sha text,
  p_run_id bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
$$;

-- Same as the applied 0043 definition, plus the cumulative guard condition.
CREATE OR REPLACE FUNCTION public.admit_code_provider_call(
  p_request_id uuid,
  p_run_id bigint,
  p_call_key text,
  p_model text,
  p_ceiling_usd numeric
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  controls public.code_runtime_controls%ROWTYPE;
  reservation public.code_spend_reservations%ROWTYPE;
  owner_id uuid;
  call_id uuid;
BEGIN
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  IF controls.enabled IS DISTINCT FROM true
    OR controls.kill_switch IS DISTINCT FROM false
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
$$;

REVOKE ALL ON FUNCTION public.code_total_spend_committed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.code_total_spend_guard_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.code_total_spend_guard_enforced() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.code_total_spend_guard_trigger() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.code_total_spend_committed() TO service_role;
GRANT EXECUTE ON FUNCTION public.code_total_spend_guard_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.code_total_spend_guard_enforced() TO service_role;

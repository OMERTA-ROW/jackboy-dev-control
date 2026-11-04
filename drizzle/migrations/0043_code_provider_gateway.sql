-- CODE provider admission gateway ledger. Every provider request made on behalf of a CODE task must
-- first be admitted here, inside the task's already-claimed spend reservation (0040).
--
-- Fail closed by construction:
--   * admission needs an enabled, non-stopped runtime whose active request/run is exactly the caller;
--   * the sum of unresolved call ceilings plus settled actuals can never exceed the task reservation;
--   * a call whose cost is uncertain (dispatched, unknown) keeps holding its FULL ceiling until an owner
--     resolves it with authoritative closed-day provider cost evidence (0041);
--   * audit writes happen in the same transaction, so an audit failure rolls the operation back;
--   * an actual cost above the admitted ceiling, or provider spend the gateway never admitted, engages
--     the Emergency Stop (kill_switch). Nothing here releases the Emergency Stop or touches 0037.
-- Admission still requires claim_code_runtime_slot, which remains blocked while
-- provider_hard_cap_verified = false, so applying this migration cannot make CODE runnable.

CREATE TABLE public.code_provider_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.action_requests(id),
  run_id bigint NOT NULL,
  call_key text NOT NULL CHECK (call_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  ceiling_usd numeric(12,6) NOT NULL CHECK (ceiling_usd > 0 AND ceiling_usd <= 5),
  status text NOT NULL DEFAULT 'admitted'
    CHECK (status IN ('admitted', 'dispatched', 'unknown', 'settled', 'aborted')),
  actual_usd numeric(12,6) CHECK (actual_usd IS NULL OR actual_usd >= 0),
  overrun boolean NOT NULL DEFAULT false,
  provider_request_id text CHECK (provider_request_id IS NULL OR length(provider_request_id) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  finished_at timestamptz,
  UNIQUE (request_id, call_key),
  CHECK (status <> 'settled' OR actual_usd IS NOT NULL),
  CHECK (status <> 'aborted' OR dispatched_at IS NULL),
  CHECK (status NOT IN ('dispatched', 'unknown', 'settled') OR dispatched_at IS NOT NULL),
  CHECK (status NOT IN ('settled', 'aborted') OR finished_at IS NOT NULL)
);
CREATE INDEX code_provider_calls_unresolved ON public.code_provider_calls(request_id)
  WHERE status IN ('admitted', 'dispatched', 'unknown');
ALTER TABLE public.code_provider_calls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.code_provider_calls FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.code_provider_calls TO service_role;

CREATE FUNCTION public.guard_code_provider_call()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CODE provider calls are append-only';
  END IF;
  IF OLD.status IN ('settled', 'aborted')
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.call_key IS DISTINCT FROM OLD.call_key
    OR NEW.model IS DISTINCT FROM OLD.model
    OR NEW.ceiling_usd IS DISTINCT FROM OLD.ceiling_usd
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.status = 'admitted' AND NEW.status NOT IN ('admitted', 'dispatched', 'aborted'))
    OR (OLD.status = 'dispatched' AND NEW.status NOT IN ('dispatched', 'unknown', 'settled'))
    OR (OLD.status = 'unknown' AND NEW.status NOT IN ('unknown', 'settled'))
  THEN
    RAISE EXCEPTION 'CODE provider call change is not allowed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER code_provider_calls_guard
  BEFORE UPDATE OR DELETE ON public.code_provider_calls
  FOR EACH ROW EXECUTE FUNCTION public.guard_code_provider_call();

-- Shared hold arithmetic: settled calls hold their actual cost, aborted calls hold nothing,
-- every other call (admitted, dispatched, unknown) holds its full ceiling.
CREATE FUNCTION public.code_provider_call_holds(p_request_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(sum(CASE status
    WHEN 'settled' THEN greatest(actual_usd, 0)
    WHEN 'aborted' THEN 0
    ELSE ceiling_usd END), 0)::numeric(12,6)
  FROM public.code_provider_calls WHERE request_id = p_request_id;
$$;

CREATE FUNCTION public.admit_code_provider_call(
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

-- Must succeed immediately before the upstream request is sent. Re-checks the Emergency Stop so a stop
-- engaged between admission and dispatch prevents the request.
CREATE FUNCTION public.dispatch_code_provider_call(p_call_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  controls public.code_runtime_controls%ROWTYPE;
  call_row public.code_provider_calls%ROWTYPE;
BEGIN
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  SELECT * INTO call_row FROM public.code_provider_calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND OR call_row.status <> 'admitted'
    OR controls.enabled IS DISTINCT FROM true
    OR controls.kill_switch IS DISTINCT FROM false
    OR controls.stop_requested_at IS NOT NULL
    OR controls.cancellation_status IS DISTINCT FROM 'not_needed'
    OR controls.active_request_id IS DISTINCT FROM call_row.request_id
    OR controls.active_run_id IS DISTINCT FROM call_row.run_id
  THEN
    RAISE EXCEPTION 'CODE provider call dispatch blocked';
  END IF;
  UPDATE public.code_provider_calls SET status = 'dispatched', dispatched_at = now() WHERE id = p_call_id;
END;
$$;

-- Releases an admitted call that was never sent. A dispatched call can never be aborted.
CREATE FUNCTION public.abort_code_provider_call(p_call_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  call_row public.code_provider_calls%ROWTYPE;
  owner_id uuid;
BEGIN
  SELECT * INTO call_row FROM public.code_provider_calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND OR call_row.status <> 'admitted' THEN
    RAISE EXCEPTION 'Only a call that was never dispatched can be aborted';
  END IF;
  SELECT requested_by INTO owner_id FROM public.action_requests WHERE id = call_row.request_id;
  UPDATE public.code_provider_calls SET status = 'aborted', actual_usd = 0, finished_at = now() WHERE id = p_call_id;
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (owner_id, 'code.provider_call_aborted',
      jsonb_build_object('call_id', p_call_id, 'reason', left(coalesce(p_reason, ''), 200)), 'aborted');
END;
$$;

-- The outcome of a dispatched call is not known (stream cut, timeout, ambiguous error, missing usage).
-- The full ceiling stays held until an owner resolves it with provider evidence.
CREATE FUNCTION public.mark_code_provider_call_unknown(p_call_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  call_row public.code_provider_calls%ROWTYPE;
  owner_id uuid;
BEGIN
  SELECT * INTO call_row FROM public.code_provider_calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND OR call_row.status <> 'dispatched' THEN
    RAISE EXCEPTION 'Only a dispatched call can be marked unknown';
  END IF;
  SELECT requested_by INTO owner_id FROM public.action_requests WHERE id = call_row.request_id;
  UPDATE public.code_provider_calls SET status = 'unknown' WHERE id = p_call_id;
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (owner_id, 'code.provider_call_unknown',
      jsonb_build_object('call_id', p_call_id, 'reason', left(coalesce(p_reason, ''), 200),
        'held_usd', call_row.ceiling_usd), 'held');
END;
$$;

-- Internal: settles a call at a known cost. An actual above the admitted ceiling is recorded in full,
-- flagged, audited and engages the Emergency Stop.
CREATE FUNCTION public.apply_code_provider_call_cost(
  p_call_id uuid,
  p_actual_usd numeric,
  p_provider_request_id text,
  p_source text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  call_row public.code_provider_calls%ROWTYPE;
  owner_id uuid;
  over boolean;
BEGIN
  SELECT * INTO call_row FROM public.code_provider_calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND OR call_row.status NOT IN ('dispatched', 'unknown')
    OR p_actual_usd IS NULL OR p_actual_usd < 0 OR p_actual_usd > 1000
  THEN
    RAISE EXCEPTION 'CODE provider call cannot be settled';
  END IF;
  SELECT requested_by INTO owner_id FROM public.action_requests WHERE id = call_row.request_id;
  over := p_actual_usd > call_row.ceiling_usd;
  UPDATE public.code_provider_calls
    SET status = 'settled', actual_usd = p_actual_usd, overrun = over,
        provider_request_id = left(p_provider_request_id, 200), finished_at = now()
    WHERE id = p_call_id;
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (owner_id, 'code.provider_call_settled',
      jsonb_build_object('call_id', p_call_id, 'source', p_source, 'actual_usd', p_actual_usd,
        'ceiling_usd', call_row.ceiling_usd, 'overrun', over), CASE WHEN over THEN 'overrun' ELSE 'settled' END);
  IF over THEN
    UPDATE public.code_runtime_controls
      SET kill_switch = true, paused_reason = 'A provider call exceeded its admitted spending ceiling',
          updated_at = now()
      WHERE singleton = true;
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (owner_id, 'code.provider_call_overrun',
        jsonb_build_object('call_id', p_call_id, 'actual_usd', p_actual_usd,
          'ceiling_usd', call_row.ceiling_usd), 'emergency_stop_engaged');
  END IF;
  RETURN over;
END;
$$;

CREATE FUNCTION public.settle_code_provider_call(
  p_call_id uuid,
  p_actual_usd numeric,
  p_provider_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (SELECT status FROM public.code_provider_calls WHERE id = p_call_id) IS DISTINCT FROM 'dispatched' THEN
    RAISE EXCEPTION 'Only a dispatched call can be settled by the gateway';
  END IF;
  RETURN public.apply_code_provider_call_cost(p_call_id, p_actual_usd, p_provider_request_id, 'gateway_usage');
END;
$$;

-- Owner-only resolution of an unresolved call, requiring authoritative closed-day provider cost
-- evidence (0041) recorded after the call was dispatched and after the day closed.
CREATE FUNCTION public.resolve_code_provider_call(
  p_actor uuid,
  p_call_id uuid,
  p_actual_usd numeric,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  controls public.code_runtime_controls%ROWTYPE;
  call_row public.code_provider_calls%ROWTYPE;
  call_day date;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only the owner can resolve CODE provider calls';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'Invalid CODE provider call resolution';
  END IF;
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  SELECT * INTO call_row FROM public.code_provider_calls WHERE id = p_call_id FOR UPDATE;
  IF NOT FOUND OR call_row.status NOT IN ('dispatched', 'unknown') THEN
    RAISE EXCEPTION 'CODE provider call is not awaiting resolution';
  END IF;
  call_day := (call_row.dispatched_at AT TIME ZONE 'UTC')::date;
  IF NOT EXISTS (
    SELECT 1 FROM public.code_provider_cost_day_reports r
    WHERE r.utc_day = call_day
      AND r.synced_at >= ((call_day + 1)::timestamp AT TIME ZONE 'UTC')
        + make_interval(secs => controls.closed_day_lag_seconds)
      AND r.synced_at >= call_row.dispatched_at + make_interval(secs => controls.reconcile_grace_seconds)
  ) THEN
    RAISE EXCEPTION 'No authoritative provider cost evidence for UTC day %; the call stays reserved', call_day;
  END IF;
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (p_actor, 'code.provider_call_resolved',
      jsonb_build_object('call_id', p_call_id, 'actual_usd', p_actual_usd, 'reason', btrim(p_reason)), 'resolved');
  RETURN public.apply_code_provider_call_cost(p_call_id, p_actual_usd, NULL, 'owner_resolution');
END;
$$;

-- Owner-only per-day reconciliation of the provider's report against what the gateway admitted.
-- Provider spend on the CODE-only key that the gateway cannot account for means something bypassed it:
-- the Emergency Stop is engaged and the result is audited.
CREATE FUNCTION public.reconcile_code_provider_day(
  p_actor uuid,
  p_day date,
  p_tolerance_usd numeric DEFAULT 0.01
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  controls public.code_runtime_controls%ROWTYPE;
  day_start timestamptz;
  provider_usd numeric(12,6);
  gateway_usd numeric(12,6);
  unaccounted numeric(12,6);
  ok boolean;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only the owner can reconcile CODE provider calls';
  END IF;
  IF p_day IS NULL OR p_tolerance_usd IS NULL OR p_tolerance_usd < 0 OR p_tolerance_usd > 1
    OR p_day >= (now() AT TIME ZONE 'UTC')::date
  THEN
    RAISE EXCEPTION 'Invalid CODE provider reconciliation request';
  END IF;
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  IF NOT EXISTS (
    SELECT 1 FROM public.code_provider_cost_day_reports r
    WHERE r.utc_day = p_day
      AND r.synced_at >= ((p_day + 1)::timestamp AT TIME ZONE 'UTC')
        + make_interval(secs => controls.closed_day_lag_seconds)
  ) THEN
    RAISE EXCEPTION 'No closed-day provider cost report for %; nothing can be reconciled', p_day;
  END IF;
  day_start := p_day::timestamp AT TIME ZONE 'UTC';
  SELECT coalesce(sum(cost_usd), 0) INTO provider_usd FROM public.code_usage_events
    WHERE source = 'openai_org_costs' AND occurred_at >= day_start AND occurred_at < day_start + interval '1 day';
  -- Upper bound: unresolved calls count at their full ceiling.
  SELECT coalesce(sum(CASE status WHEN 'settled' THEN actual_usd WHEN 'aborted' THEN 0 ELSE ceiling_usd END), 0)
    INTO gateway_usd FROM public.code_provider_calls
    WHERE dispatched_at >= day_start AND dispatched_at < day_start + interval '1 day';
  unaccounted := provider_usd - gateway_usd;
  ok := unaccounted <= p_tolerance_usd;
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (p_actor, 'code.provider_day_reconciled',
      jsonb_build_object('utc_day', p_day, 'provider_usd', provider_usd, 'gateway_usd', gateway_usd,
        'unaccounted_usd', unaccounted, 'tolerance_usd', p_tolerance_usd),
      CASE WHEN ok THEN 'reconciled' ELSE 'bypass_suspected' END);
  IF NOT ok THEN
    UPDATE public.code_runtime_controls
      SET kill_switch = true, paused_reason = 'Provider spend not admitted by the gateway', updated_at = now()
      WHERE singleton = true;
  END IF;
  RETURN jsonb_build_object('ok', ok, 'provider_usd', provider_usd, 'gateway_usd', gateway_usd,
    'unaccounted_usd', unaccounted);
END;
$$;

REVOKE ALL ON FUNCTION public.guard_code_provider_call() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.code_provider_call_holds(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admit_code_provider_call(uuid, bigint, text, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dispatch_code_provider_call(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.abort_code_provider_call(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_code_provider_call_unknown(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_code_provider_call_cost(uuid, numeric, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.settle_code_provider_call(uuid, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_code_provider_call(uuid, uuid, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_code_provider_day(uuid, date, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_code_provider_call(uuid, bigint, text, text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.dispatch_code_provider_call(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.abort_code_provider_call(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_code_provider_call_unknown(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_code_provider_call(uuid, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_code_provider_call(uuid, uuid, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_code_provider_day(uuid, date, numeric) TO service_role;
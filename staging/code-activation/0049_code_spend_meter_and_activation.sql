-- PROPOSED, NOT APPLIED. Needs explicit owner approval before it is applied.
-- Depends on the applied cumulative guard (0046_code_total_spend_guard) and hard-cap gate
-- (0047_code_hard_cap_gate); refuses to run without them, or while CODE is on.
--
-- Part A: fresh admission meter.
--   OpenAI cost reports arrive hours late, so they cannot be the "measured in the last 5 minutes"
--   input claim_code_runtime_slot requires. Every provider call made for CODE must first be admitted
--   by the gateway into code_provider_calls, so the gateway ledger is the only real-time record:
--     gateway today = every call created today at its worst case (settled = actual cost,
--                     aborted = 0, admitted/dispatched/unknown = full ceiling)
--                   + the unused headroom of any still-open task reservation.
--   measured today  = the larger of gateway today and OpenAI's reported cost for today.
--   OpenAI reports are the later cross-check: every closed UTC day (older than yesterday) on which the
--   gateway dispatched calls must have an owner-recorded closed-day report, and that report may not
--   exceed what the gateway admitted by more than $0.01. Otherwise something may have bypassed the
--   gateway and the meter refuses.
--   refresh_code_spend_meter() stamps provider_usage_at = now() ONLY when every check passes, and
--   clears it (NULL) otherwise, so a stale or failing meter can never admit a task.
--
-- Part B: owner activation gate.
--   A BEFORE trigger rejects every change that turns CODE on (enabled false -> true) or releases the
--   CODE kill switch (true -> false), unless it comes from enable_code_runtime(owner). That function
--   re-checks every gate under a row lock and, only if all pass, sets enabled = true, kill_switch =
--   false and clears the stale stop marker (stop_requested_at) that otherwise blocks every provider
--   call forever after an Emergency Stop. Turning CODE off or engaging the stop is never blocked.
--   Nothing in this migration turns CODE on.
-- Trust boundary: the service role and database owner can still alter triggers; this protects
-- application paths and accidental writes, not a compromised service role.

DO $$
BEGIN
  IF pg_catalog.to_regprocedure('public.code_total_spend_guard_enforced()') IS NULL
    OR pg_catalog.to_regprocedure('public.set_code_provider_hard_cap_verified(uuid,boolean,text)') IS NULL
  THEN
    RAISE EXCEPTION 'Apply the cumulative spend guard and the hard-cap gate first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.code_runtime_controls WHERE enabled OR NOT kill_switch) THEN
    RAISE EXCEPTION 'CODE must be off with the Emergency Stop on before this migration is applied';
  END IF;
END;
$$;

ALTER TABLE public.code_runtime_controls ADD COLUMN spend_meter jsonb;
COMMENT ON COLUMN public.code_runtime_controls.spend_meter IS
  'Last refresh_code_spend_meter() result. provider_usage_at is stamped only when it was ok.';

-- Read-only measurement. Never writes. Fails closed on anything missing.
CREATE FUNCTION public.code_spend_meter_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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
$$;

-- Called by the CODE runner immediately before claim_code_runtime_slot. Stamps freshness only on ok.
CREATE FUNCTION public.refresh_code_spend_meter()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  status jsonb;
  ok boolean;
BEGIN
  PERFORM 1 FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  status := public.code_spend_meter_status();
  ok := coalesce((status->>'ok')::boolean, false);
  UPDATE public.code_runtime_controls
    SET provider_usage_at = CASE WHEN ok THEN now() ELSE NULL END,
        spend_meter = status,
        updated_at = now()
    WHERE singleton = true;
  IF NOT ok THEN
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (NULL, 'code.spend_meter_blocked', status, 'blocked');
  END IF;
  RETURN status;
END;
$$;

CREATE FUNCTION public.code_runtime_controls_activation_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND (NEW.enabled IS TRUE OR NEW.kill_switch IS NOT TRUE))
    OR (TG_OP = 'UPDATE' AND (
      (NEW.enabled IS TRUE AND OLD.enabled IS NOT TRUE)
      OR (NEW.kill_switch IS NOT TRUE AND OLD.kill_switch IS TRUE)))
  THEN
    IF coalesce(current_setting('jackboy.code_activation', true), '') <> 'owner-enabled' THEN
      RAISE EXCEPTION 'CODE can only be turned on through enable_code_runtime';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER code_runtime_controls_activation_gate
  BEFORE INSERT OR UPDATE ON public.code_runtime_controls
  FOR EACH ROW EXECUTE FUNCTION public.code_runtime_controls_activation_gate();

-- Owner-only. Returns {ok:false, reasons} (and audits the refusal) instead of raising, so the
-- refusal record survives. Only when every gate passes does it turn CODE on.
CREATE FUNCTION public.enable_code_runtime(p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  controls public.code_runtime_controls%ROWTYPE;
  guard jsonb;
  meter jsonb;
  target jsonb;
  reasons text[] := ARRAY[]::text[];
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only the owner can turn CODE on';
  END IF;
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  IF controls.singleton IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'CODE runtime controls are missing';
  END IF;
  guard := public.code_total_spend_guard_status();
  meter := public.code_spend_meter_status();
  target := controls.allowed_targets->'OMERTA-ROW/jackboy-dev-control';

  IF controls.enabled OR NOT controls.kill_switch THEN
    reasons := reasons || 'not_stopped'::text;
  END IF;
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
  IF NOT EXISTS (SELECT 1 FROM public.automation_policy WHERE id = 1 AND paused = false) THEN
    reasons := reasons || 'global_pause'::text;
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
      VALUES (p_actor, 'code.runtime_enable_refused',
        jsonb_build_object('reasons', to_jsonb(reasons), 'guard', guard, 'meter', meter), 'blocked');
    RETURN jsonb_build_object('ok', false, 'reasons', to_jsonb(reasons));
  END IF;

  PERFORM pg_catalog.set_config('jackboy.code_activation', 'owner-enabled', true);
  UPDATE public.code_runtime_controls
    SET enabled = true,
        kill_switch = false,
        paused_reason = NULL,
        stop_requested_at = NULL,
        cancellation_status = 'not_needed',
        updated_at = now()
    WHERE singleton = true;
  PERFORM pg_catalog.set_config('jackboy.code_activation', '', true);
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (p_actor, 'code.runtime_enabled',
      jsonb_build_object('workflow_sha', target->>'workflowSha', 'guard', guard, 'meter', meter), 'ok');
  RETURN jsonb_build_object('ok', true, 'reasons', '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.code_spend_meter_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_code_spend_meter() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.code_runtime_controls_activation_gate() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enable_code_runtime(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.code_spend_meter_status() TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_code_spend_meter() TO service_role;
GRANT EXECUTE ON FUNCTION public.enable_code_runtime(uuid) TO service_role;

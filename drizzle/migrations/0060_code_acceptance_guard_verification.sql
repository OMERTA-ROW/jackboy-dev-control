-- Forward-only repair: preserve 0059 bytes and require a stopped, quiescent runtime.
DO $$
BEGIN
  IF pg_catalog.to_regprocedure('public.code_acceptance_guard_status()') IS NULL
    OR pg_catalog.to_regprocedure('public.guard_code_acceptance_reservation()') IS NULL
    OR pg_catalog.to_regprocedure('public.set_guardian_limits(integer,integer,integer)') IS NULL
    OR pg_catalog.to_regprocedure('public.code_total_spend_guard_enforced()') IS NULL
    OR pg_catalog.to_regprocedure('public.claim_code_runtime_slot(uuid,text,text,text,bigint)') IS NULL
  THEN
    RAISE EXCEPTION 'Apply 0059 and its CODE dependencies first';
  END IF;
  PERFORM 1 FROM public.code_runtime_controls
    WHERE singleton = true AND enabled = false AND kill_switch = true
      AND active_request_id IS NULL AND active_run_id IS NULL
    FOR UPDATE;
  IF NOT FOUND OR EXISTS (
    SELECT 1 FROM public.code_spend_reservations WHERE status = 'reserved'
  ) THEN
    RAISE EXCEPTION 'CODE must be disabled and stopped with no active task or reservation';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.code_acceptance_guard_status()
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.code_spend_reservations'::regclass
      AND tgname = 'code_acceptance_reservation_guard'
      AND tgfoid = 'public.guard_code_acceptance_reservation()'::regprocedure
      AND tgenabled = 'O' AND NOT tgisinternal
      AND tgtype = 7 -- ROW | BEFORE | INSERT, no other event.
      AND tgqual IS NULL AND tgnargs = 0 AND tgconstraint = 0
  );
$$;
REVOKE ALL ON FUNCTION public.code_acceptance_guard_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.code_acceptance_guard_status() TO service_role;
--> statement-breakpoint
-- Retain 0046's admission checks, lock order, accounting and audits; add guard readiness
-- inside the admission transaction so the app's earlier observation is not the final gate.
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
$$;
REVOKE ALL ON FUNCTION public.claim_code_runtime_slot(uuid,text,text,text,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_code_runtime_slot(uuid,text,text,text,bigint) TO service_role;

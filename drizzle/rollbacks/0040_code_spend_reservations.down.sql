-- Rollback for 0040_code_spend_reservations.sql. Restores the 0037 claim/finish functions.
-- Refuses to run while any unsettled reservation exists, so an in-flight or unreconciled
-- hold can never be discarded. Run only after Emergency Stop is engaged and reconciliation is complete.
-- The 0037 provider_hard_cap_verified = false invariant is never modified by 0040 or this rollback.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.code_spend_reservations WHERE status <> 'settled') THEN
    RAISE EXCEPTION 'Unsettled CODE spend reservations exist; reconcile them before rolling back';
  END IF;
END;
$$;

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
  THEN
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (request_row.requested_by, 'code.task_blocked', jsonb_build_object('request', p_request_id, 'repo', p_repository), 'blocked');
    RETURN false;
  END IF;

  UPDATE public.code_runtime_controls
    SET active_request_id = p_request_id,
        active_run_id = p_run_id,
        updated_at = now()
    WHERE singleton = true;
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (request_row.requested_by, 'code.task_started', jsonb_build_object('request', p_request_id, 'repo', p_repository, 'run_id', p_run_id), 'ok');
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_code_runtime_slot(p_request_id uuid, p_run_id bigint, p_run_attempt integer, p_outcome text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  request_row public.action_requests%ROWTYPE;
  failures integer;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('success', 'failure', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid CODE task outcome';
  END IF;
  SELECT * INTO request_row FROM public.action_requests WHERE id = p_request_id FOR UPDATE;
  IF request_row.id IS NULL OR request_row.runner_run_attempt IS DISTINCT FROM p_run_attempt THEN
    RAISE EXCEPTION 'CODE task completion does not match the authorized attempt';
  END IF;
  UPDATE public.code_runtime_controls
    SET active_request_id = NULL,
        active_run_id = NULL,
        consecutive_failures = CASE WHEN p_outcome = 'success' THEN 0
          WHEN p_outcome = 'failure' THEN consecutive_failures + 1
          ELSE consecutive_failures END,
        enabled = CASE WHEN p_outcome = 'failure' AND consecutive_failures + 1 >= 2 THEN false ELSE enabled END,
        kill_switch = CASE WHEN p_outcome = 'failure' AND consecutive_failures + 1 >= 2 THEN true ELSE kill_switch END,
        paused_reason = CASE WHEN p_outcome = 'failure' AND consecutive_failures + 1 >= 2
          THEN 'Automatically paused after two consecutive task failures' ELSE paused_reason END,
        cancellation_status = CASE
          WHEN kill_switch AND stop_requested_at IS NOT NULL AND active_request_id = p_request_id
            THEN CASE WHEN p_outcome = 'cancelled' THEN 'confirmed' ELSE 'completed' END
          ELSE cancellation_status END,
        updated_at = now()
    WHERE singleton = true
      AND active_request_id = p_request_id
      AND active_run_id = p_run_id
    RETURNING consecutive_failures INTO failures;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CODE active task does not match the completion';
  END IF;
  UPDATE public.action_requests
    SET outcome = 'CODE task ' || p_outcome || '; recorded in the audit trail.'
    WHERE id = p_request_id;
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (request_row.requested_by, 'code.task_' || p_outcome, jsonb_build_object('request', p_request_id, 'run_id', p_run_id, 'consecutive_failures', failures), p_outcome);
END;
$$;

DROP FUNCTION public.reconcile_code_spend_reservations(uuid);
DROP TABLE public.code_spend_reservations;
DROP FUNCTION public.guard_code_spend_reservation();
ALTER TABLE public.code_runtime_controls
  DROP COLUMN per_task_reserve_usd,
  DROP COLUMN reconcile_grace_seconds;

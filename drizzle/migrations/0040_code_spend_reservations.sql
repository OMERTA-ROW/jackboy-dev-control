-- CODE atomic spend reservations and reconciliation.
--
-- This migration does NOT touch the 0037 invariant
-- code_runtime_controls_provider_hard_cap_verified_check (provider_hard_cap_verified = false).
-- Admission still requires that gate, so CODE stays blocked until a separately reviewed
-- migration lands. Reservations add a second, independent admission condition: provider-reported
-- spend plus every unreconciled worst-case hold plus this task's reservation must fit the daily limit.

ALTER TABLE public.code_runtime_controls
  ADD COLUMN per_task_reserve_usd numeric(10,2) NOT NULL DEFAULT 1.00
    CHECK (per_task_reserve_usd > 0 AND per_task_reserve_usd <= 5.00),
  ADD COLUMN reconcile_grace_seconds integer NOT NULL DEFAULT 900
    CHECK (reconcile_grace_seconds BETWEEN 300 AND 86400);

CREATE TABLE public.code_spend_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES public.action_requests(id),
  run_id bigint NOT NULL,
  reserved_usd numeric(12,6) NOT NULL CHECK (reserved_usd > 0 AND reserved_usd <= 5),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'finished', 'settled')),
  outcome text CHECK (outcome IN ('success', 'failure', 'cancelled')),
  released_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK (released_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  settled_at timestamptz,
  CHECK (released_usd <= reserved_usd),
  CHECK (status = 'reserved' OR finished_at IS NOT NULL),
  CHECK ((status = 'settled') = (settled_at IS NOT NULL)),
  CHECK (status <> 'settled' OR released_usd = reserved_usd)
);
CREATE INDEX code_spend_reservations_open ON public.code_spend_reservations(status)
  WHERE status <> 'settled';

ALTER TABLE public.code_spend_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.code_spend_reservations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.code_spend_reservations TO service_role;

-- Settled rows are history: only the settlement transition is allowed and never reversed.
CREATE FUNCTION public.guard_code_spend_reservation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CODE spend reservations are append-only';
  END IF;
  IF OLD.status = 'settled'
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.run_id IS DISTINCT FROM OLD.run_id
    OR NEW.reserved_usd IS DISTINCT FROM OLD.reserved_usd
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.status = 'finished' AND NEW.status = 'reserved')
  THEN
    RAISE EXCEPTION 'CODE spend reservation change is not allowed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER code_spend_reservations_guard
  BEFORE UPDATE OR DELETE ON public.code_spend_reservations
  FOR EACH ROW EXECUTE FUNCTION public.guard_code_spend_reservation();

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
    VALUES (request_row.requested_by, 'code.task_blocked', jsonb_build_object('request', p_request_id, 'repo', p_repository), 'blocked');
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
    VALUES (request_row.requested_by, 'code.task_started', jsonb_build_object('request', p_request_id, 'repo', p_repository, 'run_id', p_run_id, 'reserved_usd', controls.per_task_reserve_usd), 'ok');
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
  reserve_usd numeric(10,2);
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
    RETURNING consecutive_failures, per_task_reserve_usd INTO failures, reserve_usd;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CODE active task does not match the completion';
  END IF;
  -- The hold stays counted after the task ends; only reconciliation against a later provider
  -- cost report can release it, whatever the outcome (success, failure or cancellation).
  UPDATE public.code_spend_reservations
    SET status = 'finished', outcome = p_outcome, finished_at = now()
    WHERE request_id = p_request_id AND status = 'reserved';
  IF NOT FOUND AND NOT EXISTS (
    SELECT 1 FROM public.code_spend_reservations WHERE request_id = p_request_id
  ) THEN
    INSERT INTO public.code_spend_reservations(request_id, run_id, reserved_usd, status, outcome, finished_at)
      VALUES (p_request_id, p_run_id, reserve_usd, 'finished', p_outcome, now());
  END IF;
  UPDATE public.action_requests
    SET outcome = 'CODE task ' || p_outcome || '; recorded in the audit trail.'
    WHERE id = p_request_id;
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (request_row.requested_by, 'code.task_' || p_outcome, jsonb_build_object('request', p_request_id, 'run_id', p_run_id, 'consecutive_failures', failures), p_outcome);
END;
$$;

-- Releases a finished hold only when a provider cost report was recorded at least the grace
-- period after the task ended, within the same UTC day as the whole task. The report's daily
-- total then already contains the real cost, so keeping the hold would double count it. Holds
-- that cross a UTC day boundary are never released automatically and keep blocking admission.
CREATE OR REPLACE FUNCTION public.reconcile_code_spend_reservations(p_actor uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  controls public.code_runtime_controls%ROWTYPE;
  settled_count integer;
  released_total numeric(12,6);
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only the owner can reconcile CODE spend reservations';
  END IF;
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  IF controls.provider_costs_synced_at IS NULL
    OR controls.provider_costs_synced_at > now() + interval '30 seconds'
  THEN
    RETURN 0;
  END IF;

  WITH settled AS (
    UPDATE public.code_spend_reservations
      SET status = 'settled', released_usd = reserved_usd, settled_at = now()
      WHERE status = 'finished'
        AND finished_at + make_interval(secs => controls.reconcile_grace_seconds)
          <= controls.provider_costs_synced_at
        AND date_trunc('day', created_at AT TIME ZONE 'UTC')
          = date_trunc('day', controls.provider_costs_synced_at AT TIME ZONE 'UTC')
        AND date_trunc('day', finished_at AT TIME ZONE 'UTC')
          = date_trunc('day', controls.provider_costs_synced_at AT TIME ZONE 'UTC')
      RETURNING reserved_usd
  )
  SELECT count(*)::integer, coalesce(sum(reserved_usd), 0) INTO settled_count, released_total FROM settled;

  IF settled_count > 0 THEN
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (p_actor, 'code.spend_reconciled',
        jsonb_build_object('settled', settled_count, 'released_usd', released_total,
          'provider_costs_synced_at', controls.provider_costs_synced_at), 'reconciled');
  END IF;
  RETURN settled_count;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_code_spend_reservation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_code_runtime_slot(uuid, text, text, text, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_code_runtime_slot(uuid, bigint, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_code_spend_reservations(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_code_runtime_slot(uuid, text, text, text, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_code_runtime_slot(uuid, bigint, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_code_spend_reservations(uuid) TO service_role;

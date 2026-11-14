-- ROLLBACK (prepared, NOT applied). Returns the database from the 0067-0070 state to the installed 0066 state.
-- Run only with separate owner approval, after rolling back the owner-scope change first, inside one transaction.
-- The three CODE functions are restored byte-for-byte from the live definitions read on 2026-11-14 before install.
-- 0070
DROP TRIGGER omni_permit_generation_stamp ON public.omni_execution_permits;
DROP TRIGGER omni_permit_generation_code ON public.code_runtime_controls;
DROP TRIGGER omni_permit_generation_global ON public.automation_policy;
DROP FUNCTION public.omni_execution_permit_action(text,jsonb);
ALTER FUNCTION public.omni_execution_permit_action_without_safety_generation(text,jsonb) RENAME TO omni_execution_permit_action;
DROP FUNCTION public.omni_permit_generation_trigger();
ALTER TABLE public.omni_execution_permits DROP COLUMN stop_generation;
DROP TABLE public.omni_permit_safety_generation;
-- 0069
DROP TRIGGER omni_execution_permit_closed ON public.omni_execution_permits;
DROP FUNCTION public.omni_execution_permit_closed();
DROP FUNCTION public.omni_execution_permit_action(text,jsonb);
ALTER FUNCTION public.omni_execution_permit_action_without_worker(text,jsonb) RENAME TO omni_execution_permit_action;
DROP FUNCTION public.omni_execution_control(uuid,uuid,uuid,text,jsonb);
ALTER FUNCTION public.omni_execution_control_without_lease(uuid,uuid,uuid,text,jsonb) RENAME TO omni_execution_control;
-- 0068
DROP TRIGGER omni_execution_code_stop ON public.code_runtime_controls;
DROP TRIGGER omni_execution_global_stop ON public.automation_policy;
DROP FUNCTION public.omni_execution_stop_trigger();
DROP FUNCTION public.omni_execution_control(uuid,uuid,uuid,text,jsonb);
DROP FUNCTION public.omni_execution_cancel_ack(uuid,text);
DROP FUNCTION public.claim_omni_execution_nonce(text,text);
DROP TABLE public.omni_execution_jobs;
DROP FUNCTION public.omni_execution_job_guard();
DROP TABLE public.omni_execution_connections;
DELETE FROM public.omni_callback_nonces WHERE nonce LIKE 'execution:%';
-- 0067
DROP FUNCTION public.omni_execution_permit_action(text,jsonb);
ALTER FUNCTION public.omni_execution_permit_action_unlocked(text,jsonb) RENAME TO omni_execution_permit_action;
REVOKE ALL ON FUNCTION public.omni_execution_permit_action(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_execution_permit_action(text,jsonb) TO service_role;
-- CODE admission functions as live before install (0070 only added a Kill Switch row share lock)
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

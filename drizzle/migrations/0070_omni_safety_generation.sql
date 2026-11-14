-- Forward-only hardening: retain published 0065-0067 bytes and all owner decisions.
CREATE TABLE public.omni_permit_safety_generation (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  generation bigint NOT NULL DEFAULT 1
);
INSERT INTO public.omni_permit_safety_generation(singleton) VALUES(true);
ALTER TABLE public.omni_permit_safety_generation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.omni_permit_safety_generation FROM PUBLIC,anon,authenticated,service_role;
ALTER TABLE public.omni_execution_permits ADD COLUMN stop_generation bigint NOT NULL DEFAULT 0;

CREATE FUNCTION public.omni_permit_generation_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
END $$;
CREATE TRIGGER omni_permit_generation_stamp BEFORE INSERT ON public.omni_execution_permits
  FOR EACH ROW EXECUTE FUNCTION public.omni_permit_generation_trigger();
CREATE TRIGGER omni_permit_generation_code AFTER UPDATE OF enabled,kill_switch ON public.code_runtime_controls
  FOR EACH ROW EXECUTE FUNCTION public.omni_permit_generation_trigger();
CREATE TRIGGER omni_permit_generation_global AFTER UPDATE OF paused ON public.automation_policy
  FOR EACH ROW EXECUTE FUNCTION public.omni_permit_generation_trigger();
REVOKE ALL ON FUNCTION public.omni_permit_generation_trigger() FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.omni_execution_permit_action(text,jsonb)
  RENAME TO omni_execution_permit_action_without_safety_generation;
REVOKE ALL ON FUNCTION public.omni_execution_permit_action_without_safety_generation(text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.omni_execution_permit_action(_op text,_a jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
END $$;
REVOKE ALL ON FUNCTION public.omni_execution_permit_action(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.omni_execution_permit_action(text,jsonb) TO service_role;

-- Installed CODE definitions, with policy locked before the existing control/request locks.
CREATE OR REPLACE FUNCTION public.claim_code_runtime_slot(p_request_id uuid,p_repository text,p_ref text,p_workflow_sha text,p_run_id bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
END $$;

CREATE OR REPLACE FUNCTION public.admit_code_provider_call(p_request_id uuid,p_run_id bigint,p_call_key text,p_model text,p_ceiling_usd numeric)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
END $$;

CREATE OR REPLACE FUNCTION public.dispatch_code_provider_call(p_call_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
END $$;

-- Owner-approved forward migration (Nov 20, 2026): enforce the $0.50 per-call CODE limit in the
-- database. Live admit_code_provider_call (read 2026-11-20) byte-for-byte except ONE added line:
--   OR p_ceiling_usd > 0.50
-- Owner, ACL (postgres + service_role EXECUTE only), SECURITY DEFINER and empty search_path are
-- unchanged. No table, row, grant, setting, switch, Stop or permit is touched.
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
    OR NOT EXISTS (SELECT 1 FROM public.automation_policy WHERE id = 1 AND paused = false)
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
    OR p_ceiling_usd > 0.50
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
END $function$;

DO $check$
DECLARE f oid := 'public.admit_code_provider_call(uuid,bigint,text,text,numeric)'::regprocedure;
BEGIN
  IF position('p_ceiling_usd > 0.50' IN (SELECT prosrc FROM pg_proc WHERE oid = f)) = 0
  THEN RAISE EXCEPTION 'per-call $0.50 check is not installed'; END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = f)
     OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR has_function_privilege('anon', f, 'EXECUTE')
     OR NOT has_function_privilege('service_role', f, 'EXECUTE')
  THEN RAISE EXCEPTION 'admit_code_provider_call security attributes changed'; END IF;
END $check$;

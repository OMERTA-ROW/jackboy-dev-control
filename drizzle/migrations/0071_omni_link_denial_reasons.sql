-- Refine the existing session gate's denials without granting any new authority.
-- Applied 0030/0044 bytes stay unchanged; execution and permit gates are untouched.
CREATE OR REPLACE FUNCTION public.omni_link_action(_op text, _a jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 j public.omni_inbound_jobs; s public.omni_link_sessions;
 client text := _a->>'clientId'; project uuid := (_a->>'projectId')::uuid;
 approval uuid := (_a->>'approvalId')::uuid; owner_id uuid := (_a->>'ownerId')::uuid;
 expiry timestamptz := (_a->>'approvalExpiresAt')::timestamptz;
 job_id uuid := (_a->>'jobId')::uuid;
 answer jsonb; action text; result_status text; denial text;
BEGIN
 IF _op='reject' THEN
  denial := CASE WHEN _a->>'reason' IN (
   'link_approval_missing','link_approval_expired','link_approval_expiry_invalid',
   'link_project_missing','link_project_owner_mismatch','link_project_inactive',
   'link_owner_role_required','kill_switch_on','safety_state_unavailable',
   'authentication_failed','invalid_request','project_denied','action_denied',
   'kind_denied','job_id_required','runner_unavailable','session_expired_or_invalid',
   'replay','session_limit','job_not_found','concurrency_limit'
  ) THEN _a->>'reason' ELSE 'request_denied' END;
  INSERT INTO public.site_log(actor,action,category,status,summary,project_id,detail) VALUES
   ('omni-link','omni.link.denied','config','blocked','Scoped protocol request rejected',project,
    jsonb_build_object('reason',denial));
  RETURN jsonb_build_object('http',200);
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('omni-link:' || client, 0));
 IF _op NOT IN ('handshake','submit','status','run','cancel','finish','probe') THEN RAISE EXCEPTION 'invalid operation'; END IF;
 IF _op NOT IN ('finish','probe') THEN
  denial := CASE
   WHEN expiry IS NULL THEN 'link_approval_missing'
   WHEN expiry <= now() THEN 'link_approval_expired'
   WHEN expiry > now() + interval '24 hours' THEN 'link_approval_expiry_invalid'
   WHEN NOT EXISTS (SELECT 1 FROM public.owner_projects WHERE id=project) THEN 'link_project_missing'
   WHEN NOT EXISTS (SELECT 1 FROM public.owner_projects WHERE id=project AND created_by=owner_id) THEN 'link_project_owner_mismatch'
   WHEN NOT EXISTS (SELECT 1 FROM public.owner_projects WHERE id=project AND created_by=owner_id AND active) THEN 'link_project_inactive'
   WHEN NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=owner_id AND role='owner') THEN 'link_owner_role_required'
   WHEN (SELECT paused FROM public.automation_policy WHERE id=1) IS NULL THEN 'safety_state_unavailable'
   WHEN (SELECT paused FROM public.automation_policy WHERE id=1) THEN 'kill_switch_on'
  END;
  IF denial IS NOT NULL THEN RETURN jsonb_build_object('http',403,'error',denial); END IF;
  IF _op <> 'handshake' THEN
   SELECT * INTO s FROM public.omni_link_sessions WHERE token_hash=_a->>'tokenHash'
    AND client_id=client AND project_id=project AND approval_id=approval AND expires_at>now();
   IF NOT FOUND THEN RETURN jsonb_build_object('http',401,'error','session_expired_or_invalid'); END IF;
  END IF;
  INSERT INTO public.omni_callback_nonces(nonce) VALUES ('link-v2:' || client || ':' || (_a->>'nonce')) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('http',409,'error','replay'); END IF;
 END IF;
 WITH expired AS (
  UPDATE public.omni_inbound_jobs SET status='timed_out', updated_at=now()
  WHERE client_id=client AND status IN ('queued','running') AND deadline<=now() RETURNING id, project_id
 ) INSERT INTO public.site_log(actor,action,category,status,summary,project_id,detail)
 SELECT 'omni-link','omni.link.timed_out','config','failed','Protocol job deadline elapsed',project_id,jsonb_build_object('jobId',id) FROM expired;
 IF _op='handshake' THEN
  DELETE FROM public.omni_link_sessions WHERE expires_at<=now();
  DELETE FROM public.omni_callback_nonces WHERE nonce LIKE 'link-v2:%' AND received_at < now()-interval '10 minutes';
  IF (SELECT count(*) FROM public.omni_link_sessions WHERE client_id=client)>=8 THEN
   RETURN jsonb_build_object('http',429,'error','session_limit'); END IF;
  INSERT INTO public.omni_link_sessions VALUES (_a->>'newTokenHash',client,project,approval,least(now()+interval '5 minutes',expiry)) RETURNING * INTO s;
  answer:=jsonb_build_object('http',200,'expiresAt',s.expires_at); action:='handshake';
 ELSE
  SELECT * INTO j FROM public.omni_inbound_jobs WHERE id=job_id FOR UPDATE;
  IF FOUND AND (j.client_id<>client OR j.project_id<>project OR j.approval_id<>approval) THEN
   RETURN jsonb_build_object('http',404,'error','job_not_found'); END IF;
  IF _op='submit' THEN
   IF _a->>'kind' IS DISTINCT FROM 'protocol.self-test' THEN RETURN jsonb_build_object('http',403,'error','kind_denied'); END IF;
   IF j.id IS NOT NULL THEN
    RETURN jsonb_build_object('http',200,'job',to_jsonb(j),'duplicate',true);
   END IF;
   IF (SELECT count(*) FROM public.omni_inbound_jobs WHERE client_id=client AND status IN ('queued','running'))>=2 THEN
    RETURN jsonb_build_object('http',429,'error','concurrency_limit'); END IF;
   INSERT INTO public.omni_inbound_jobs(id,client_id,project_id,approval_id,kind,status,deadline)
    VALUES(job_id,client,project,approval,'protocol.self-test','queued',least(now()+interval '60 seconds',expiry)) RETURNING * INTO j;
   answer:=jsonb_build_object('http',202,'job',to_jsonb(j)); action:='queued';
  ELSE
   IF j.id IS NULL THEN RETURN jsonb_build_object('http',404,'error','job_not_found'); END IF;
   IF _op IN ('probe','finish') AND (expiry<=now() OR COALESCE((SELECT paused FROM public.automation_policy WHERE id=1),true) OR NOT EXISTS(SELECT 1 FROM public.owner_projects WHERE id=project AND created_by=owner_id AND active) OR NOT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=owner_id AND role='owner')) AND j.status IN ('queued','running') THEN
    UPDATE public.omni_inbound_jobs SET status='cancelled',updated_at=now() WHERE id=j.id RETURNING * INTO j;
    INSERT INTO public.site_log(actor,action,category,status,summary,project_id) VALUES ('omni-link','omni.link.revoked','config','blocked','Protocol job stopped after revocation',project);
   END IF;
   IF _op IN ('status','probe') THEN RETURN jsonb_build_object('http',200,'job',to_jsonb(j));
   ELSIF _op='cancel' AND j.status IN ('queued','running') THEN
    UPDATE public.omni_inbound_jobs SET status='cancelled',updated_at=now() WHERE id=j.id RETURNING * INTO j; action:='cancelled';
   ELSIF _op='run' AND j.status='queued' THEN
    UPDATE public.omni_inbound_jobs SET status='running',updated_at=now() WHERE id=j.id RETURNING * INTO j; action:='running';
   ELSIF _op='finish' AND j.status='running' THEN
    result_status:=CASE WHEN (_a->>'passed')::boolean IS TRUE THEN 'completed' ELSE 'failed' END;
    UPDATE public.omni_inbound_jobs SET status=result_status,updated_at=now(),
     result=jsonb_build_object('passed',result_status='completed','checks',CASE WHEN result_status='completed' THEN 3 ELSE 0 END,'runner','restricted-protocol-self-test')
     WHERE id=j.id RETURNING * INTO j; action:=result_status;
   END IF;
   answer:=jsonb_build_object('http',200,'job',to_jsonb(j),'claimed',action='running');
  END IF;
 END IF;
 IF action IS NOT NULL THEN
  INSERT INTO public.site_log(actor,action,category,status,summary,project_id,detail)
   VALUES('omni-link','omni.link.'||action,'config','info','Scoped protocol link state transition',project,
    jsonb_build_object('jobId',job_id,'approvalId',approval,'state',action));
 END IF;
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION public.omni_link_action(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_link_action(text,jsonb) TO service_role;

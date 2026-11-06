-- Disabled until owner-reviewed migration + backend configuration. Reverse-link
-- sessions do NOT set omni_connection.verified or grant CODE/GitHub authority.
CREATE TABLE public.omni_link_sessions (
 token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 client_id text NOT NULL, project_id uuid NOT NULL REFERENCES public.owner_projects(id),
 approval_id uuid NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE public.omni_inbound_jobs (
 id uuid PRIMARY KEY, client_id text NOT NULL,
 project_id uuid NOT NULL REFERENCES public.owner_projects(id), approval_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind = 'protocol.self-test'),
 status text NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','timed_out')),
 deadline timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(), result jsonb
);
ALTER TABLE public.omni_link_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_inbound_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.omni_link_sessions, public.omni_inbound_jobs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.omni_link_sessions, public.omni_inbound_jobs TO service_role;
CREATE INDEX omni_link_session_expiry ON public.omni_link_sessions(expires_at);
CREATE INDEX omni_inbound_active ON public.omni_inbound_jobs(client_id,status);

CREATE FUNCTION public.omni_link_action(_op text, _a jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 j public.omni_inbound_jobs; s public.omni_link_sessions;
 client text := _a->>'clientId'; project uuid := (_a->>'projectId')::uuid;
 approval uuid := (_a->>'approvalId')::uuid; owner_id uuid := (_a->>'ownerId')::uuid;
 expiry timestamptz := (_a->>'approvalExpiresAt')::timestamptz;
 job_id uuid := (_a->>'jobId')::uuid;
 answer jsonb; action text; result_status text;
BEGIN
 -- One client-wide transaction lock serializes nonce consumption, session quota,
 -- idempotency and the in-flight limit across application replicas.
 IF _op='reject' THEN
  INSERT INTO public.site_log(actor,action,category,status,summary,project_id) VALUES
   ('omni-link','omni.link.denied','config','blocked','Scoped protocol request rejected',project);
  RETURN jsonb_build_object('http',200);
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('omni-link:' || client, 0));
 IF _op NOT IN ('handshake','submit','status','run','cancel','finish','probe') THEN RAISE EXCEPTION 'invalid operation'; END IF;
 IF _op NOT IN ('finish','probe') THEN
  IF expiry IS NULL OR expiry <= now() OR expiry > now() + interval '24 hours'
   OR NOT EXISTS (SELECT 1 FROM public.owner_projects WHERE id=project AND created_by=owner_id AND active)
   OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=owner_id AND role='owner')
   OR COALESCE((SELECT paused FROM public.automation_policy WHERE id=1),true)
   THEN RETURN jsonb_build_object('http',403,'error','grant_unavailable'); END IF;
  IF _op <> 'handshake' THEN
   SELECT * INTO s FROM public.omni_link_sessions WHERE token_hash=_a->>'tokenHash'
    AND client_id=client AND project_id=project AND approval_id=approval AND expires_at>now();
   IF NOT FOUND THEN RETURN jsonb_build_object('http',401,'error','session_expired_or_invalid'); END IF;
  END IF;
  INSERT INTO public.omni_callback_nonces(nonce) VALUES ('link-v2:' || client || ':' || (_a->>'nonce')) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('http',409,'error','replay'); END IF;
 END IF;
 -- Expired jobs never run again; losing a response is not authority to rerun.
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
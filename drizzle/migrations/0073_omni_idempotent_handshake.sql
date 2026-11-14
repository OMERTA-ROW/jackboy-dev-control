-- Retry identifiers are retained through the approval window so an expired token is never revived.
CREATE TABLE public.omni_handshake_requests (
 client_id text NOT NULL,
 project_id uuid NOT NULL,
 approval_id uuid NOT NULL,
 handshake_id uuid NOT NULL,
 token_hash text NOT NULL,
 expires_at timestamptz NOT NULL,
 approval_expires_at timestamptz NOT NULL,
 PRIMARY KEY (client_id, project_id, approval_id, handshake_id)
);
ALTER TABLE public.omni_handshake_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.omni_handshake_requests FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.omni_handshake_requests TO service_role;

CREATE FUNCTION public.omni_link_idempotent_handshake(_a jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 client text := _a->>'clientId';
 project uuid := (_a->>'projectId')::uuid;
 approval uuid := (_a->>'approvalId')::uuid;
 owner_id uuid := (_a->>'ownerId')::uuid;
 expiry timestamptz := (_a->>'approvalExpiresAt')::timestamptz;
 request_id uuid := (_a->>'handshakeId')::uuid;
 previous public.omni_handshake_requests;
 result jsonb;
 denial text;
BEGIN
 IF client IS NULL OR client !~ '^[a-zA-Z0-9_-]{1,64}$' OR request_id IS NULL THEN
  RAISE EXCEPTION 'invalid handshake request';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('omni-link:' || client, 0));
 DELETE FROM public.omni_handshake_requests WHERE client_id=client AND approval_expires_at<=now();
 SELECT * INTO previous FROM public.omni_handshake_requests
  WHERE client_id=client AND project_id=project AND approval_id=approval AND handshake_id=request_id;
 IF FOUND THEN
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
  DELETE FROM public.omni_callback_nonces
   WHERE left(nonce, length('link-v2:' || client || ':')) = 'link-v2:' || client || ':'
    AND received_at < now()-interval '10 minutes';
  INSERT INTO public.omni_callback_nonces(nonce) VALUES ('link-v2:' || client || ':' || (_a->>'nonce')) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('http',409,'error','replay'); END IF;
  IF previous.token_hash IS DISTINCT FROM _a->>'newTokenHash'
   OR previous.approval_expires_at IS DISTINCT FROM expiry
   OR previous.expires_at <= now()
   OR NOT EXISTS (SELECT 1 FROM public.omni_link_sessions WHERE token_hash=previous.token_hash
     AND client_id=client AND project_id=project AND approval_id=approval AND expires_at>now())
   THEN RETURN jsonb_build_object('http',409,'error','handshake_id_expired_or_conflict'); END IF;
  INSERT INTO public.site_log(actor,action,category,status,summary,project_id,detail)
   VALUES('omni-link','omni.link.handshake_retry','config','info','Scoped protocol handshake retry',project,
    jsonb_build_object('approvalId',approval));
  RETURN jsonb_build_object('http',200,'expiresAt',previous.expires_at,'duplicate',true);
 END IF;
 result := public.omni_link_action('handshake', _a);
 IF (result->>'http')::integer = 200 THEN
  INSERT INTO public.omni_handshake_requests VALUES
   (client,project,approval,request_id,_a->>'newTokenHash',(result->>'expiresAt')::timestamptz,expiry);
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.omni_link_idempotent_handshake(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_link_idempotent_handshake(jsonb) TO service_role;

CREATE TABLE public.project_github_checks (project_id uuid PRIMARY KEY REFERENCES public.owner_projects(id) ON DELETE CASCADE, repo text NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(), evidence jsonb NOT NULL);
GRANT SELECT ON public.project_github_checks TO authenticated;
GRANT ALL ON public.project_github_checks TO service_role;
ALTER TABLE public.project_github_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner reads permission evidence" ON public.project_github_checks FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'owner'));
CREATE OR REPLACE FUNCTION public.remove_owner_passkey(_actor uuid,_key uuid,_grant uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE k public.owner_passkeys; g public.step_up_grants;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=_actor AND role='owner') THEN RAISE EXCEPTION 'Owner only'; END IF;
 SELECT * INTO k FROM public.owner_passkeys WHERE id=_key AND user_id=_actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Passkey not found for this owner'; END IF;
 SELECT * INTO g FROM public.step_up_grants WHERE id=_grant AND user_id=_actor AND action='remove_passkey' AND target='passkey:'||_key::text AND used_at IS NULL AND expires_at>now() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Fresh passkey confirmation required for this device'; END IF;
 UPDATE public.step_up_grants SET used_at=now() WHERE id=_grant;
 UPDATE public.step_up_grants SET used_at=now() WHERE user_id=_actor AND credential_id=k.credential_id AND used_at IS NULL;
 DELETE FROM public.owner_passkeys WHERE id=_key AND user_id=_actor;
 INSERT INTO public.audit_logs(actor,action,outcome,detail) VALUES(_actor,'passkey.removed','ok',jsonb_build_object('device',k.label,'site',k.rp_id));
 RETURN jsonb_build_object('removed',true,'label',k.label);
END $$;
REVOKE ALL ON FUNCTION public.remove_owner_passkey(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.remove_owner_passkey(uuid,uuid,uuid) TO service_role;
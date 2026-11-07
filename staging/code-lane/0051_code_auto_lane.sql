-- STAGED, NOT APPLIED. Needs the owner's separate OK.
-- Per-site "automatic lane" switch for CODE. Off by default; only the owner (server-verified, after a fresh passkey) can change it.
CREATE TABLE public.code_auto_lane (
  repo text PRIMARY KEY CHECK (repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  enabled boolean NOT NULL DEFAULT false,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.code_auto_lane TO authenticated;
GRANT ALL ON public.code_auto_lane TO service_role;
ALTER TABLE public.code_auto_lane ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads code auto lane" ON public.code_auto_lane FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));

CREATE OR REPLACE FUNCTION public.set_code_auto_lane(p_actor uuid, p_repo text, p_enabled boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c record;
BEGIN
  IF p_actor IS NULL OR NOT public.has_role(p_actor, 'owner'::app_role) THEN
    RAISE EXCEPTION 'Only the owner can change the automatic lane';
  END IF;
  IF p_repo IS NULL OR p_repo !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' THEN
    RAISE EXCEPTION 'Invalid repository';
  END IF;
  SELECT allowed_targets, kill_switch, active_request_id, consecutive_failures INTO c FROM public.code_runtime_controls LIMIT 1;
  IF p_enabled THEN
    IF c.allowed_targets IS NULL OR NOT (c.allowed_targets ? p_repo) THEN RAISE EXCEPTION 'This site is not on the CODE allow list'; END IF;
    IF c.active_request_id IS NOT NULL THEN RAISE EXCEPTION 'Can''t turn the automatic lane on mid-task'; END IF;
    IF c.consecutive_failures >= 2 THEN RAISE EXCEPTION 'CODE is in a two-failure stop'; END IF;
  END IF;
  INSERT INTO public.code_auto_lane (repo, enabled, updated_by, updated_at) VALUES (p_repo, p_enabled, p_actor, now())
  ON CONFLICT (repo) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now();
  INSERT INTO public.audit_logs (actor, action, detail, outcome)
  VALUES (p_actor, 'code.auto_lane', jsonb_build_object('repo', p_repo, 'enabled', p_enabled), 'ok');
  RETURN jsonb_build_object('repo', p_repo, 'enabled', p_enabled);
END $$;
REVOKE ALL ON FUNCTION public.set_code_auto_lane(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_code_auto_lane(uuid, text, boolean) TO service_role;

CREATE TABLE public.update_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.owner_projects(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  channel text NOT NULL DEFAULT 'test' CHECK (channel IN ('test','beta','live')),
  platform text NOT NULL DEFAULT 'web' CHECK (char_length(platform) BETWEEN 1 AND 40),
  token_hash text NOT NULL UNIQUE,
  current_version text,
  last_release_id uuid,
  state text NOT NULL DEFAULT 'enrolled' CHECK (state IN ('enrolled','up_to_date','updating','healthy','failed','rolled_back','revoked')),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.update_targets TO authenticated;
GRANT ALL ON public.update_targets TO service_role;
REVOKE SELECT (token_hash) ON public.update_targets FROM authenticated;
ALTER TABLE public.update_targets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads update targets" ON public.update_targets FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));

CREATE TABLE public.update_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES public.update_targets(id) ON DELETE CASCADE,
  release_id uuid REFERENCES public.releases(id) ON DELETE SET NULL,
  version text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('policy_denied','downloaded','verified','installed','healthy','failed','rolled_back')),
  detail text NOT NULL DEFAULT '',
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX update_installs_target_idx ON public.update_installs(target_id, created_at DESC);
GRANT SELECT ON public.update_installs TO authenticated;
GRANT SELECT, INSERT ON public.update_installs TO service_role;
ALTER TABLE public.update_installs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads installs" ON public.update_installs FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));
CREATE TRIGGER update_installs_no_change BEFORE UPDATE OR DELETE ON public.update_installs FOR EACH ROW EXECUTE FUNCTION public.site_log_immutable();
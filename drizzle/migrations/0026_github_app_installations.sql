CREATE TABLE public.github_installations (
  installation_id bigint PRIMARY KEY,
  account_login text NOT NULL,
  account_type text NOT NULL DEFAULT '',
  repositories text[] NOT NULL DEFAULT '{}',
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing_permissions text[] NOT NULL DEFAULT '{}',
  approved_by uuid,
  verified_at timestamptz,
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.github_installations TO authenticated;
GRANT ALL ON public.github_installations TO service_role;
ALTER TABLE public.github_installations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner reads GitHub installations" ON public.github_installations
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'));
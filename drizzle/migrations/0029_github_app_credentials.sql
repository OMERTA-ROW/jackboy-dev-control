CREATE TABLE IF NOT EXISTS public.github_app_credentials (
  id text PRIMARY KEY DEFAULT 'jackboy',
  app_id text NOT NULL,
  slug text NOT NULL,
  owner_login text NOT NULL,
  html_url text,
  private_key_enc text NOT NULL,
  webhook_secret_enc text,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_app_credentials_single CHECK (id = 'jackboy')
);
ALTER TABLE public.github_app_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.github_app_credentials FROM anon, authenticated;
GRANT ALL ON public.github_app_credentials TO service_role;
COMMENT ON TABLE public.github_app_credentials IS 'Server-only. Private key and webhook secret are AES-GCM encrypted with GITHUB_APP_ENCRYPTION_KEY. No client policies by design.';
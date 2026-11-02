ALTER TABLE public.omni_jobs ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE public.omni_jobs
  ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS repo text,
  ADD COLUMN IF NOT EXISTS code_request_id uuid UNIQUE,
  ADD COLUMN IF NOT EXISTS omni_job_ref text,
  ADD COLUMN IF NOT EXISTS result jsonb,
  ADD COLUMN IF NOT EXISTS pr_url text,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE public.omni_jobs DROP CONSTRAINT IF EXISTS omni_job_status;
ALTER TABLE public.omni_jobs ADD CONSTRAINT omni_job_status CHECK (status IN ('queued','sent','running','completed','failed','cancelled'));

CREATE TABLE public.omni_connection (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  verified boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  omni_version text,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_checked_at timestamptz,
  last_error text
);
GRANT SELECT ON public.omni_connection TO authenticated;
GRANT ALL ON public.omni_connection TO service_role;
ALTER TABLE public.omni_connection ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read omni connection" ON public.omni_connection FOR SELECT TO authenticated USING (public.my_role() IS NOT NULL);
INSERT INTO public.omni_connection (id) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE public.omni_callback_nonces (
  nonce text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.omni_callback_nonces TO service_role;
ALTER TABLE public.omni_callback_nonces ENABLE ROW LEVEL SECURITY;
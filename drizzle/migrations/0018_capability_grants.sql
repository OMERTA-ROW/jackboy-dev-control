CREATE TABLE public.capability_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability text NOT NULL,
  project_id uuid NOT NULL REFERENCES public.owner_projects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'missing' CHECK (status IN ('missing','needs_approval','awaiting_setup','connected','expired','revoked','unavailable','error')),
  method text NOT NULL DEFAULT '',
  scopes text NOT NULL DEFAULT '',
  account text,
  expires_at timestamptz,
  approved_by uuid, approved_at timestamptz,
  last_verified_at timestamptz,
  last_error text,
  verify_attempts int NOT NULL DEFAULT 0,
  paused boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (capability, project_id)
);
GRANT SELECT ON public.capability_grants TO authenticated;
GRANT ALL ON public.capability_grants TO service_role;
ALTER TABLE public.capability_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads capability grants" ON public.capability_grants FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));
ALTER TABLE public.foundry_tasks ADD COLUMN IF NOT EXISTS needs_capability text;
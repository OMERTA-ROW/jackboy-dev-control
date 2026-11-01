ALTER TABLE public.owner_projects
  ADD COLUMN IF NOT EXISTS site_status text NOT NULL DEFAULT 'needs_address',
  ADD COLUMN IF NOT EXISTS site_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS site_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS site_fail_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS site_next_check_at timestamptz,
  ADD COLUMN IF NOT EXISTS site_monitoring boolean NOT NULL DEFAULT true;
UPDATE public.owner_projects SET site_status = 'checking', site_next_check_at = now() WHERE site_url IS NOT NULL;
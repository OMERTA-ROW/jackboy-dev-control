ALTER TABLE public.update_writer_settings ADD COLUMN IF NOT EXISTS autopilot_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.owner_projects ADD COLUMN IF NOT EXISTS site_url text, ADD COLUMN IF NOT EXISTS autopilot boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS connect_state text NOT NULL DEFAULT 'not_started', ADD COLUMN IF NOT EXISTS connect_pr_url text, ADD COLUMN IF NOT EXISTS connect_error text;
ALTER TABLE public.update_proposals ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'writer', ADD COLUMN IF NOT EXISTS autopilot_note text;
CREATE TABLE public.site_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.owner_projects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running',
  trigger text NOT NULL DEFAULT 'manual',
  pages_checked int NOT NULL DEFAULT 0,
  links_checked int NOT NULL DEFAULT 0,
  avg_ms int,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  fix_proposal_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
GRANT SELECT, DELETE ON public.site_scans TO authenticated;
GRANT ALL ON public.site_scans TO service_role;
ALTER TABLE public.site_scans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads scans" ON public.site_scans FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'owner'));
CREATE POLICY "owner deletes scans" ON public.site_scans FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'owner'));
CREATE INDEX site_scans_project ON public.site_scans(project_id, created_at DESC);
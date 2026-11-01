CREATE TABLE public.owner_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  lovable_url text,
  description text NOT NULL DEFAULT '',
  goals text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  last_proposal_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.owner_projects TO authenticated;
GRANT ALL ON public.owner_projects TO service_role;
ALTER TABLE public.owner_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner manages projects" ON public.owner_projects FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'owner')) WITH CHECK (public.has_role(auth.uid(),'owner'));

CREATE TABLE public.update_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.owner_projects(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected','sent_to_omni')),
  title text NOT NULL,
  what_to_change text NOT NULL,
  why text NOT NULL,
  build_prompt text NOT NULL,
  model text,
  trigger text NOT NULL DEFAULT 'manual',
  edited boolean NOT NULL DEFAULT false,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX update_proposals_status ON public.update_proposals(status, created_at DESC);
GRANT SELECT, UPDATE, DELETE ON public.update_proposals TO authenticated;
GRANT ALL ON public.update_proposals TO service_role;
ALTER TABLE public.update_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads proposals" ON public.update_proposals FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'owner'));
CREATE POLICY "owner edits proposals" ON public.update_proposals FOR UPDATE TO authenticated USING (public.has_role(auth.uid(),'owner')) WITH CHECK (public.has_role(auth.uid(),'owner'));
CREATE POLICY "owner deletes proposals" ON public.update_proposals FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'owner'));

CREATE TABLE public.update_writer_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  frequency_hours int NOT NULL DEFAULT 24 CHECK (frequency_hours IN (0,6,12,24,72,168)),
  last_run_at timestamptz,
  lock_until timestamptz,
  paused_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.update_writer_settings(id) VALUES (1);
GRANT SELECT, UPDATE ON public.update_writer_settings TO authenticated;
GRANT ALL ON public.update_writer_settings TO service_role;
ALTER TABLE public.update_writer_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads writer settings" ON public.update_writer_settings FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'owner'));
CREATE POLICY "owner updates writer settings" ON public.update_writer_settings FOR UPDATE TO authenticated USING (public.has_role(auth.uid(),'owner')) WITH CHECK (public.has_role(auth.uid(),'owner'));
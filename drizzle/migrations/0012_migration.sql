ALTER TABLE public.owner_projects
  ADD COLUMN IF NOT EXISTS demo_detection boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS repair_policy text NOT NULL DEFAULT 'approve' CHECK (repair_policy IN ('approve','autopilot'));

CREATE TABLE public.finding_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.owner_projects(id) ON DELETE CASCADE,
  finding_key text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('ignored','remove_demo','repair')),
  proposal_id uuid,
  message text NOT NULL DEFAULT '',
  decided_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, finding_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.finding_decisions TO authenticated;
GRANT ALL ON public.finding_decisions TO service_role;
ALTER TABLE public.finding_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner manages finding decisions" ON public.finding_decisions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role)) WITH CHECK (public.has_role(auth.uid(), 'owner'::app_role));
CREATE TABLE public.agent_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid REFERENCES public.owner_projects(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('inspect','edit','diff','pr','test','failure','fix','note','next_action')),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  repo text, branch text, commit_sha text, url text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  notion_synced_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_memory_project_idx ON public.agent_memory(project_id, created_at DESC);
GRANT SELECT, DELETE ON public.agent_memory TO authenticated;
GRANT ALL ON public.agent_memory TO service_role;
ALTER TABLE public.agent_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads memory" ON public.agent_memory FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));
CREATE POLICY "owner deletes memory" ON public.agent_memory FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));
CREATE TABLE public.foundry_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.owner_projects(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  summary text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'improvement' CHECK (kind IN ('improvement','repair','security','test','docs')),
  risk text NOT NULL DEFAULT 'low' CHECK (risk IN ('low','medium','sensitive')),
  state text NOT NULL DEFAULT 'discovered' CHECK (state IN ('discovered','analyzing','patch_prepared','testing','awaiting_approval','approved','executing','verifying','completed','failed','rolled_back','rejected','blocked')),
  dedupe_key text NOT NULL,
  repo text, branch text, commit_sha text, pr_number int, pr_url text,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  test_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  approved_action text CHECK (approved_action IN ('open_draft_pr','read_checks')),
  idempotency_key text,
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts int NOT NULL DEFAULT 3,
  paused boolean NOT NULL DEFAULT false,
  blocked_reason text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','scheduled')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, dedupe_key)
);
CREATE INDEX foundry_tasks_state_idx ON public.foundry_tasks(state, updated_at DESC);
GRANT SELECT ON public.foundry_tasks TO authenticated;
GRANT ALL ON public.foundry_tasks TO service_role;
ALTER TABLE public.foundry_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads foundry tasks" ON public.foundry_tasks FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));

CREATE TABLE public.foundry_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid REFERENCES public.foundry_tasks(id) ON DELETE SET NULL,
  project_id uuid,
  from_state text, to_state text,
  action text NOT NULL,
  actor text NOT NULL,
  note text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX foundry_events_task_idx ON public.foundry_events(task_id, created_at);
GRANT SELECT ON public.foundry_events TO authenticated;
GRANT SELECT, INSERT ON public.foundry_events TO service_role;
ALTER TABLE public.foundry_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads foundry events" ON public.foundry_events FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));
CREATE OR REPLACE FUNCTION public.foundry_events_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.task_id IS NOT NULL AND NEW.task_id IS NULL AND NEW.action = OLD.action AND NEW.note = OLD.note THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Foundry history is immutable';
END $$;
CREATE TRIGGER foundry_events_no_change BEFORE UPDATE OR DELETE ON public.foundry_events FOR EACH ROW EXECUTE FUNCTION public.foundry_events_immutable();

CREATE TABLE public.foundry_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  verified_count int NOT NULL DEFAULT 0,
  last_task_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.foundry_patterns TO authenticated;
GRANT ALL ON public.foundry_patterns TO service_role;
ALTER TABLE public.foundry_patterns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads patterns" ON public.foundry_patterns FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));

CREATE TABLE public.foundry_schedule (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled boolean NOT NULL DEFAULT false,
  interval_hours int NOT NULL DEFAULT 24 CHECK (interval_hours BETWEEN 1 AND 720),
  daily_task_quota int NOT NULL DEFAULT 3 CHECK (daily_task_quota BETWEEN 0 AND 20),
  last_run_at timestamptz,
  last_project_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.foundry_schedule (id) VALUES (1) ON CONFLICT DO NOTHING;
GRANT SELECT ON public.foundry_schedule TO authenticated;
GRANT ALL ON public.foundry_schedule TO service_role;
ALTER TABLE public.foundry_schedule ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads schedule" ON public.foundry_schedule FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));
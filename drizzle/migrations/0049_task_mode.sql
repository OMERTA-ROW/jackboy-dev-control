-- Task Mode: owner tasks broken into fixed steps; all writes go through server code (service role) after owner + passkey checks.
CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  goal text NOT NULL CHECK (char_length(goal) BETWEEN 3 AND 2000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','waiting','done','failed','stopped')),
  failures integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  stop_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz
);
GRANT SELECT ON public.tasks TO authenticated;
GRANT ALL ON public.tasks TO service_role;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads tasks" ON public.tasks FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));

CREATE TABLE public.task_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 12),
  tool text NOT NULL,
  step_type text NOT NULL,
  args jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  project_id uuid,
  why text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','waiting','approved','running','done','failed','stopped')),
  approved_at timestamptz,
  approval_grant uuid,
  approval_reason text,
  result jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (task_id, position)
);
GRANT SELECT ON public.task_steps TO authenticated;
GRANT ALL ON public.task_steps TO service_role;
ALTER TABLE public.task_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads task steps" ON public.task_steps FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));

-- What a step does can never change after drafting; approvals are bound to its fingerprint.
CREATE OR REPLACE FUNCTION public.task_steps_fixed() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.position IS DISTINCT FROM OLD.position OR NEW.tool IS DISTINCT FROM OLD.tool
     OR NEW.step_type IS DISTINCT FROM OLD.step_type OR NEW.args IS DISTINCT FROM OLD.args OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
     OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'A task step''s action can''t change after it is drafted';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER task_steps_fixed BEFORE UPDATE ON public.task_steps FOR EACH ROW EXECUTE FUNCTION public.task_steps_fixed();

CREATE TABLE public.task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  step_id uuid,
  kind text NOT NULL,
  message text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_events_task_idx ON public.task_events (task_id, created_at);
GRANT SELECT ON public.task_events TO authenticated;
GRANT ALL ON public.task_events TO service_role;
ALTER TABLE public.task_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads task events" ON public.task_events FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));
CREATE OR REPLACE FUNCTION public.task_events_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Task history is append-only'; END $$;
CREATE TRIGGER task_events_immutable BEFORE UPDATE ON public.task_events FOR EACH ROW EXECUTE FUNCTION public.task_events_immutable();

-- Owner's "no approval needed" list. Only low-risk step types may appear; the five never-skip types are refused here too.
CREATE TABLE public.task_skip_rules (
  step_type text PRIMARY KEY CHECK (step_type IN ('scan_site','inspect_code','save_draft')),
  project_ids uuid[] NOT NULL DEFAULT '{}',
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.task_skip_rules TO authenticated;
GRANT ALL ON public.task_skip_rules TO service_role;
ALTER TABLE public.task_skip_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads task skip rules" ON public.task_skip_rules FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));

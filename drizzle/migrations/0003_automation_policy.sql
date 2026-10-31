CREATE TABLE public.automation_policy (
  id int PRIMARY KEY DEFAULT 1,
  tier int NOT NULL DEFAULT 0,
  paused boolean NOT NULL DEFAULT false,
  guardian_verified boolean NOT NULL DEFAULT false,
  max_files int NOT NULL DEFAULT 3,
  max_lines int NOT NULL DEFAULT 50,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1),
  CONSTRAINT tier_range CHECK (tier BETWEEN 0 AND 2),
  CONSTRAINT scope_bounds CHECK (max_files BETWEEN 1 AND 20 AND max_lines BETWEEN 1 AND 500)
);
INSERT INTO public.automation_policy (id) VALUES (1);
GRANT SELECT ON public.automation_policy TO authenticated;
GRANT ALL ON public.automation_policy TO service_role;
ALTER TABLE public.automation_policy ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read policy" ON public.automation_policy FOR SELECT TO authenticated USING (public.my_role() IS NOT NULL);

-- Owner-only policy change; guardian_verified cannot be set here (server verification only). Logged.
CREATE OR REPLACE FUNCTION public.set_automation_policy(_tier int, _paused boolean, _max_files int, _max_lines int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN RAISE EXCEPTION 'Only the owner can change the automation policy'; END IF;
  UPDATE public.automation_policy SET tier = _tier, paused = _paused, max_files = _max_files, max_lines = _max_lines,
    updated_by = auth.uid(), updated_at = now() WHERE id = 1;
  INSERT INTO public.audit_logs(actor, action, detail, outcome) VALUES (auth.uid(), 'automation.policy',
    jsonb_build_object('tier', _tier, 'paused', _paused, 'max_files', _max_files, 'max_lines', _max_lines), 'ok');
END $$;
REVOKE ALL ON FUNCTION public.set_automation_policy(int, boolean, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_automation_policy(int, boolean, int, int) TO authenticated;

CREATE TABLE public.learning_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.agent_projects(id) ON DELETE CASCADE,
  kind text NOT NULL,
  summary text NOT NULL,
  outcome text NOT NULL DEFAULT 'recorded',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_kind CHECK (kind IN ('diagnostic','patch_diff','test_result','guardian_verdict','deployment','rollback','feedback'))
);
CREATE INDEX learning_events_project ON public.learning_events (project_id, created_at DESC);
GRANT SELECT, INSERT ON public.learning_events TO authenticated;
GRANT ALL ON public.learning_events TO service_role;
ALTER TABLE public.learning_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read learning" ON public.learning_events FOR SELECT TO authenticated USING (public.my_role() IS NOT NULL);
CREATE POLICY "members record learning" ON public.learning_events FOR INSERT TO authenticated WITH CHECK (public.my_role() IS NOT NULL AND created_by = auth.uid());

CREATE TABLE public.playbooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  trigger text NOT NULL,
  steps text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  verified_by uuid,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.playbooks TO authenticated;
GRANT ALL ON public.playbooks TO service_role;
ALTER TABLE public.playbooks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read playbooks" ON public.playbooks FOR SELECT TO authenticated USING (public.my_role() IS NOT NULL);
CREATE POLICY "members draft playbooks" ON public.playbooks FOR INSERT TO authenticated WITH CHECK (public.my_role() IS NOT NULL AND created_by = auth.uid() AND verified = false AND verified_by IS NULL);
CREATE POLICY "owner verifies playbooks" ON public.playbooks FOR UPDATE TO authenticated USING (public.has_role(auth.uid(),'owner')) WITH CHECK (public.has_role(auth.uid(),'owner'));
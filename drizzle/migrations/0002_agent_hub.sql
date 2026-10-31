CREATE TABLE public.agent_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  lovable_project_ref text,
  repo_url text,
  enrolled boolean NOT NULL DEFAULT false,
  angeltech_enabled boolean NOT NULL DEFAULT true,
  demontech_enabled boolean NOT NULL DEFAULT false,
  health text NOT NULL DEFAULT 'unknown',
  last_report_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_project_health CHECK (health IN ('unknown','ok','degraded','failing'))
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_projects TO authenticated;
GRANT ALL ON public.agent_projects TO service_role;
ALTER TABLE public.agent_projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read projects" ON public.agent_projects FOR SELECT TO authenticated USING (public.my_role() IS NOT NULL);
CREATE POLICY "managers add projects" ON public.agent_projects FOR INSERT TO authenticated WITH CHECK (public.is_manager(auth.uid()) AND created_by = auth.uid());
CREATE POLICY "managers edit projects" ON public.agent_projects FOR UPDATE TO authenticated USING (public.is_manager(auth.uid())) WITH CHECK (public.is_manager(auth.uid()));
CREATE POLICY "owner deletes projects" ON public.agent_projects FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'owner'));

-- Ingest credentials: hash only, never readable by app users.
CREATE TABLE public.agent_project_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.agent_projects(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  scope text NOT NULL DEFAULT 'ingest:write',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
GRANT ALL ON public.agent_project_tokens TO service_role;
ALTER TABLE public.agent_project_tokens ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.agent_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.agent_projects(id) ON DELETE CASCADE,
  agent text NOT NULL,
  kind text NOT NULL,
  severity text NOT NULL,
  title text NOT NULL,
  detail text NOT NULL DEFAULT '',
  source_url text,
  priority int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_report_agent CHECK (agent IN ('angeltech','demontech')),
  CONSTRAINT agent_report_status CHECK (status IN ('open','acknowledged','resolved','dismissed'))
);
CREATE INDEX agent_reports_queue ON public.agent_reports (status, priority DESC, created_at);
GRANT SELECT, UPDATE ON public.agent_reports TO authenticated;
GRANT ALL ON public.agent_reports TO service_role;
ALTER TABLE public.agent_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read reports" ON public.agent_reports FOR SELECT TO authenticated USING (public.my_role() IS NOT NULL);
CREATE POLICY "managers triage reports" ON public.agent_reports FOR UPDATE TO authenticated USING (public.is_manager(auth.uid())) WITH CHECK (public.is_manager(auth.uid()));

CREATE TABLE public.agent_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.agent_projects(id) ON DELETE CASCADE,
  report_id uuid REFERENCES public.agent_reports(id) ON DELETE SET NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  action text NOT NULL DEFAULT 'merge',
  sensitive boolean NOT NULL DEFAULT false,
  tests_passed boolean NOT NULL DEFAULT false,
  pr_url text,
  status text NOT NULL DEFAULT 'proposed',
  created_by uuid NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_proposal_action CHECK (action IN ('open_pr','merge','deploy_production','sensitive_change')),
  CONSTRAINT agent_proposal_status CHECK (status IN ('proposed','approved','rejected'))
);
GRANT SELECT, INSERT ON public.agent_proposals TO authenticated;
GRANT ALL ON public.agent_proposals TO service_role;
ALTER TABLE public.agent_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read proposals" ON public.agent_proposals FOR SELECT TO authenticated USING (public.my_role() IS NOT NULL);
CREATE POLICY "members propose" ON public.agent_proposals FOR INSERT TO authenticated
  WITH CHECK (public.my_role() IS NOT NULL AND created_by = auth.uid() AND status = 'proposed' AND decided_by IS NULL);

-- Only the owner decides; recorded in the audit log.
CREATE OR REPLACE FUNCTION public.decide_proposal(_id uuid, _approve boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN RAISE EXCEPTION 'Only the owner can approve or reject proposals'; END IF;
  UPDATE public.agent_proposals SET status = CASE WHEN _approve THEN 'approved' ELSE 'rejected' END,
    decided_by = auth.uid(), decided_at = now() WHERE id = _id AND status = 'proposed';
  IF NOT FOUND THEN RAISE EXCEPTION 'Proposal not found or already decided'; END IF;
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (auth.uid(), 'proposal.decide', jsonb_build_object('proposal', _id, 'approved', _approve), 'ok');
END $$;
REVOKE ALL ON FUNCTION public.decide_proposal(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decide_proposal(uuid, boolean) TO authenticated;
ALTER TABLE public.agents
  ADD COLUMN adapter text NOT NULL DEFAULT 'owner_agent',
  ADD COLUMN model_provider text NOT NULL DEFAULT '',
  ADD COLUMN model_name text NOT NULL DEFAULT '',
  ADD COLUMN passport_approved boolean NOT NULL DEFAULT false,
  ADD COLUMN passport_approved_by uuid,
  ADD COLUMN passport_approved_at timestamptz,
  ADD COLUMN jax_enrolled boolean NOT NULL DEFAULT false,
  ADD COLUMN jax_consent_purpose text,
  ADD COLUMN jax_consent_at timestamptz,
  ADD CONSTRAINT agent_adapter CHECK (adapter IN ('owner_agent','third_party','local'));
GRANT UPDATE (adapter, model_provider, model_name) ON public.agents TO authenticated;

-- Any identity/scope change voids the passport until the owner re-approves.
CREATE OR REPLACE FUNCTION public.agents_reset_passport()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF (NEW.adapter, NEW.model_provider, NEW.model_name, NEW.category, NEW.project_id, NEW.autonomy)
     IS DISTINCT FROM (OLD.adapter, OLD.model_provider, OLD.model_name, OLD.category, OLD.project_id, OLD.autonomy)
     AND NEW.passport_approved = OLD.passport_approved THEN
    NEW.passport_approved := false; NEW.passport_approved_by := NULL; NEW.passport_approved_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agents_reset_passport BEFORE UPDATE ON public.agents FOR EACH ROW EXECUTE FUNCTION public.agents_reset_passport();

CREATE OR REPLACE FUNCTION public.approve_passport(_id uuid, _approve boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN RAISE EXCEPTION 'Only the owner can approve agent passports'; END IF;
  UPDATE public.agents SET passport_approved = _approve,
    passport_approved_by = CASE WHEN _approve THEN auth.uid() END,
    passport_approved_at = CASE WHEN _approve THEN now() END WHERE id = _id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agent not found'; END IF;
  INSERT INTO public.audit_logs(actor, action, detail, outcome) VALUES (auth.uid(), 'agent.passport', jsonb_build_object('agent', _id, 'approved', _approve), 'ok');
END $$;
REVOKE ALL ON FUNCTION public.approve_passport(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_passport(uuid, boolean) TO authenticated;

-- JAX enrollment: owner-only, explicit consent purpose required, Vault data never in scope.
CREATE OR REPLACE FUNCTION public.set_jax_enrollment(_id uuid, _enroll boolean, _purpose text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'owner') THEN RAISE EXCEPTION 'Only the owner can enroll agents in JAX'; END IF;
  IF _enroll AND (coalesce(length(trim(_purpose)),0) < 10) THEN RAISE EXCEPTION 'A consent purpose (10+ characters) is required'; END IF;
  IF _enroll AND _purpose ~* 'vault' THEN RAISE EXCEPTION 'Vault data is never permitted'; END IF;
  UPDATE public.agents SET jax_enrolled = _enroll,
    jax_consent_purpose = CASE WHEN _enroll THEN trim(_purpose) END,
    jax_consent_at = CASE WHEN _enroll THEN now() END WHERE id = _id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agent not found'; END IF;
  INSERT INTO public.audit_logs(actor, action, detail, outcome) VALUES (auth.uid(), 'agent.jax', jsonb_build_object('agent', _id, 'enrolled', _enroll, 'purpose', _purpose), 'ok');
END $$;
REVOKE ALL ON FUNCTION public.set_jax_enrollment(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_jax_enrollment(uuid, boolean, text) TO authenticated;

ALTER TABLE public.agent_reports ADD COLUMN agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL;

CREATE TABLE public.omni_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.agent_projects(id) ON DELETE CASCADE,
  report_id uuid REFERENCES public.agent_reports(id) ON DELETE SET NULL,
  kind text NOT NULL,
  instructions text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued',
  sent_at timestamptz,
  guardian_verdict text NOT NULL DEFAULT 'pending',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT omni_job_kind CHECK (kind IN ('code','test')),
  CONSTRAINT omni_job_status CHECK (status IN ('queued','sent','completed','failed','cancelled')),
  CONSTRAINT omni_job_guardian CHECK (guardian_verdict IN ('pending','pass','fail'))
);
GRANT SELECT, INSERT ON public.omni_jobs TO authenticated;
GRANT ALL ON public.omni_jobs TO service_role;
ALTER TABLE public.omni_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read omni jobs" ON public.omni_jobs FOR SELECT TO authenticated USING (public.my_role() IS NOT NULL);
CREATE POLICY "managers queue omni jobs" ON public.omni_jobs FOR INSERT TO authenticated
  WITH CHECK (public.is_manager(auth.uid()) AND created_by = auth.uid() AND status = 'queued' AND sent_at IS NULL AND guardian_verdict = 'pending');
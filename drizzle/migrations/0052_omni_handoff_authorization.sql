-- OMNI build/test handoffs: a dispatch grant is issued and stays usable only while the live link is
-- freshly verified, the owner acts on their own enrolled project, and a current, unrevoked
-- project authorization covers the job kind and repository. Grants still never enable execution.

CREATE TABLE public.omni_project_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.agent_projects(id),
  owner_id uuid NOT NULL,
  kinds text[] NOT NULL CHECK (cardinality(kinds) BETWEEN 1 AND 2 AND kinds <@ ARRAY['code','test']::text[]),
  repo text NOT NULL CHECK (repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IS NULL OR char_length(revoked_reason) <= 300),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.omni_project_authorizations TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.omni_project_authorizations TO service_role;
ALTER TABLE public.omni_project_authorizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads omni project authorizations" ON public.omni_project_authorizations
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role) AND owner_id = auth.uid());
CREATE UNIQUE INDEX omni_project_one_live_authorization
  ON public.omni_project_authorizations(project_id) WHERE revoked_at IS NULL;

ALTER TABLE public.omni_dispatch_grants
  ADD COLUMN authorization_id uuid REFERENCES public.omni_project_authorizations(id);

-- True only for a verified handshake under 5 minutes old with a recorded configuration fingerprint.
-- The app additionally compares that fingerprint with the current settings (isOmniVerified).
CREATE FUNCTION public.omni_link_live() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((
    SELECT verified AND verified_at IS NOT NULL AND config_hash IS NOT NULL
      AND verified_at > now() - interval '5 minutes' AND verified_at <= now() + interval '30 seconds'
    FROM public.omni_connection WHERE id
  ), false)
$$;
REVOKE ALL ON FUNCTION public.omni_link_live() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_link_live() TO service_role;

CREATE FUNCTION public.omni_project_authorization_action(
  _op text, _actor uuid, _project uuid, _kinds text[], _step uuid, _days int, _reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  p public.agent_projects;
  a public.omni_project_authorizations;
  step public.step_up_grants;
  repo_name text;
  revoked_grants int := 0;
BEGIN
  IF _op IS NULL OR _op NOT IN ('grant', 'revoke') THEN RAISE EXCEPTION 'Invalid authorization operation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _actor AND role = 'owner') THEN
    RAISE EXCEPTION 'Owner required';
  END IF;
  SELECT * INTO p FROM public.agent_projects WHERE id = _project FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Project not found'; END IF;

  UPDATE public.omni_project_authorizations SET revoked_at = now(), revoked_reason = 'expired'
    WHERE project_id = _project AND revoked_at IS NULL AND expires_at <= now();

  IF _op = 'revoke' THEN
    UPDATE public.omni_project_authorizations
      SET revoked_at = now(), revoked_reason = left(COALESCE(NULLIF(trim(_reason), ''), 'revoked by owner'), 300)
      WHERE project_id = _project AND owner_id = _actor AND revoked_at IS NULL
      RETURNING * INTO a;
    UPDATE public.omni_dispatch_grants SET revoked_at = now()
      WHERE project_id = _project AND revoked_at IS NULL;
    GET DIAGNOSTICS revoked_grants = ROW_COUNT;
    INSERT INTO public.site_log(actor, action, category, status, summary, project_id, detail)
      VALUES(_actor::text, 'omni.project.revoke', 'approval', 'ok',
        'OMNI build/test access revoked for project', p.id,
        jsonb_build_object('authorizationId', a.id, 'revokedJobApprovals', revoked_grants));
    RETURN jsonb_build_object('revoked', true, 'authorizationId', a.id, 'revokedJobApprovals', revoked_grants);
  END IF;

  IF _kinds IS NULL OR cardinality(_kinds) NOT BETWEEN 1 AND 2 OR NOT (_kinds <@ ARRAY['code','test']::text[]) THEN
    RAISE EXCEPTION 'Only build and test can be authorized';
  END IF;
  IF _days IS NULL OR _days < 1 OR _days > 30 THEN RAISE EXCEPTION 'Access lasts 1 to 30 days'; END IF;
  repo_name := substring(p.repo_url from '^https://github\.com/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$');
  IF p.created_by IS DISTINCT FROM _actor OR NOT p.enrolled OR repo_name IS NULL THEN
    RAISE EXCEPTION 'Project scope unavailable';
  END IF;
  IF NOT public.omni_link_live() THEN RAISE EXCEPTION 'OMNI live link is not verified'; END IF;
  SELECT * INTO step FROM public.step_up_grants
    WHERE id = _step AND user_id = _actor AND action = 'omni_project_scope'
    AND target = 'omni-project:' || _project::text AND used_at IS NULL AND expires_at > now()
    AND credential_id NOT LIKE 'recent:%'
    FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.owner_passkeys WHERE user_id = _actor AND credential_id = step.credential_id
  ) THEN RAISE EXCEPTION 'Fresh project-scoped passkey required'; END IF;
  IF EXISTS (SELECT 1 FROM public.omni_project_authorizations WHERE project_id = _project AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'OMNI already has access to this project; revoke it first';
  END IF;
  UPDATE public.step_up_grants SET used_at = now() WHERE id = step.id;
  INSERT INTO public.omni_project_authorizations(project_id, owner_id, kinds, repo, expires_at)
    VALUES(p.id, _actor, (SELECT array_agg(DISTINCT k ORDER BY k) FROM unnest(_kinds) k), repo_name,
      now() + make_interval(days => _days))
    RETURNING * INTO a;
  INSERT INTO public.site_log(actor, action, category, status, summary, project_id, detail)
    VALUES(_actor::text, 'omni.project.authorize', 'approval', 'ok',
      'OMNI build/test access authorized for project', p.id,
      jsonb_build_object('authorizationId', a.id, 'kinds', a.kinds, 'repo', a.repo, 'expiresAt', a.expires_at));
  RETURN jsonb_build_object('id', a.id, 'projectId', a.project_id, 'kinds', a.kinds,
    'repo', a.repo, 'expiresAt', a.expires_at);
END $$;
REVOKE ALL ON FUNCTION public.omni_project_authorization_action(text,uuid,uuid,text[],uuid,int,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_project_authorization_action(text,uuid,uuid,text[],uuid,int,text) TO service_role;

CREATE OR REPLACE FUNCTION public.omni_dispatch_grant_action(_op text, _actor uuid, _job uuid, _grant uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  j public.omni_jobs;
  p public.agent_projects;
  g public.omni_dispatch_grants;
  a public.omni_project_authorizations;
  step public.step_up_grants;
  valid_grant boolean;
  reason text;
BEGIN
  IF _op IS NULL OR _op NOT IN ('issue', 'revoke', 'check', 'record_quarantined', 'record_cancelled') THEN
    RAISE EXCEPTION 'Invalid grant operation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _actor AND role = 'owner') THEN
    RAISE EXCEPTION 'Owner required';
  END IF;
  SELECT * INTO j FROM public.omni_jobs WHERE id = _job FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Job not found'; END IF;
  SELECT * INTO p FROM public.agent_projects WHERE id = j.project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Project not found'; END IF;

  IF _op = 'issue' THEN
    IF j.status <> 'queued' OR j.sent_at IS NOT NULL OR j.code_request_id IS NOT NULL
      OR j.kind NOT IN ('code', 'test') OR j.repo IS NULL
      OR char_length(j.instructions) < 3 OR char_length(j.instructions) > 4000
      OR j.repo !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
      OR p.created_by <> _actor OR NOT p.enrolled
      OR p.repo_url IS DISTINCT FROM 'https://github.com/' || j.repo
      OR COALESCE((SELECT paused FROM public.automation_policy WHERE id = 1), true)
      THEN RAISE EXCEPTION 'Job scope unavailable'; END IF;
    IF NOT public.omni_link_live() THEN RAISE EXCEPTION 'OMNI live link is not verified'; END IF;
    SELECT * INTO a FROM public.omni_project_authorizations
      WHERE project_id = p.id AND owner_id = _actor AND revoked_at IS NULL AND expires_at > now()
      AND repo = j.repo AND j.kind = ANY(kinds);
    IF NOT FOUND THEN RAISE EXCEPTION 'No current OMNI authorization covers this project and job kind'; END IF;
    SELECT * INTO step FROM public.step_up_grants
      WHERE id = _grant AND user_id = _actor AND action = 'omni_dispatch'
      AND target = 'omni-job:' || _job::text AND used_at IS NULL AND expires_at > now()
      AND credential_id NOT LIKE 'recent:%'
      FOR UPDATE;
    IF NOT FOUND OR NOT EXISTS (
      SELECT 1 FROM public.owner_passkeys
      WHERE user_id = _actor AND credential_id = step.credential_id
    ) THEN RAISE EXCEPTION 'Fresh job-scoped passkey required'; END IF;
    UPDATE public.omni_dispatch_grants SET revoked_at = now()
      WHERE job_id = _job AND revoked_at IS NULL AND expires_at <= now();
    IF EXISTS (SELECT 1 FROM public.omni_dispatch_grants WHERE job_id = _job AND revoked_at IS NULL)
      THEN RAISE EXCEPTION 'A live grant already exists'; END IF;
    UPDATE public.step_up_grants SET used_at = now() WHERE id = step.id;
    INSERT INTO public.omni_dispatch_grants(job_id, project_id, owner_id, kind, repo, instructions, expires_at, authorization_id)
      VALUES(j.id, p.id, _actor, j.kind, j.repo, j.instructions, now() + interval '15 minutes', a.id)
      RETURNING * INTO g;
    INSERT INTO public.site_log(actor, action, category, status, summary, project_id, detail)
      VALUES(_actor::text, 'omni.dispatch.grant', 'approval', 'ok',
        'Receive-only ' || CASE j.kind WHEN 'code' THEN 'build' ELSE 'test' END || ' handoff approved', p.id,
        jsonb_build_object('jobId', j.id, 'grantId', g.id, 'authorizationId', a.id, 'kind', j.kind));
    RETURN jsonb_build_object('id', g.id, 'expiresAt', g.expires_at,
      'ownerId', g.owner_id, 'projectId', g.project_id, 'jobId', g.job_id,
      'repo', g.repo, 'kind', g.kind, 'instructions', g.instructions, 'authorizationId', a.id);
  END IF;

  SELECT * INTO g FROM public.omni_dispatch_grants
    WHERE id = _grant AND job_id = _job AND owner_id = _actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Grant not found'; END IF;
  IF _op = 'revoke' THEN
    IF g.revoked_at IS NULL THEN
      UPDATE public.omni_dispatch_grants SET revoked_at = now() WHERE id = g.id;
      INSERT INTO public.site_log(actor, action, category, status, summary, project_id, detail)
        VALUES(_actor::text, 'omni.dispatch.revoke', 'approval', 'ok', 'Receive-only dispatch grant revoked', p.id,
          jsonb_build_object('jobId', j.id, 'grantId', g.id));
    END IF;
    RETURN jsonb_build_object('revoked', true);
  END IF;

  SELECT * INTO a FROM public.omni_project_authorizations WHERE id = g.authorization_id;
  reason := CASE
    WHEN g.revoked_at IS NOT NULL THEN 'grant_revoked'
    WHEN g.expires_at <= now() THEN 'grant_expired'
    WHEN COALESCE((SELECT paused FROM public.automation_policy WHERE id = 1), true) THEN 'kill_switch'
    WHEN NOT public.omni_link_live() THEN 'link'
    WHEN a.id IS NULL THEN 'authorization'
    WHEN a.revoked_at IS NOT NULL THEN 'authorization_revoked'
    WHEN a.expires_at <= now() THEN 'authorization_expired'
    WHEN a.owner_id <> _actor OR a.project_id <> g.project_id OR a.repo <> g.repo OR NOT (g.kind = ANY(a.kinds))
      THEN 'authorization_scope'
    WHEN g.project_id <> j.project_id OR p.created_by <> _actor OR NOT p.enrolled
      OR p.repo_url IS DISTINCT FROM 'https://github.com/' || g.repo THEN 'project'
    WHEN j.status <> 'queued' OR j.sent_at IS NOT NULL OR j.code_request_id IS NOT NULL
      OR j.kind <> g.kind OR j.repo <> g.repo OR j.instructions <> g.instructions THEN 'job_changed'
    ELSE NULL END;
  valid_grant := reason IS NULL;
  IF _op = 'check' THEN
    IF NOT valid_grant THEN RETURN jsonb_build_object('valid', false, 'reason', reason); END IF;
    RETURN jsonb_build_object('valid', true, 'id', g.id, 'expiresAt', g.expires_at,
      'ownerId', g.owner_id, 'projectId', g.project_id, 'jobId', g.job_id,
      'repo', g.repo, 'kind', g.kind, 'instructions', g.instructions, 'authorizationId', a.id);
  END IF;
  IF NOT valid_grant THEN RAISE EXCEPTION 'Grant unavailable: %', reason; END IF;
  INSERT INTO public.omni_dispatch_receipts(job_id, grant_id, status)
    VALUES(j.id, g.id, CASE _op WHEN 'record_cancelled' THEN 'cancelled' ELSE 'quarantined' END)
    ON CONFLICT (job_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()
    WHERE omni_dispatch_receipts.grant_id = EXCLUDED.grant_id
      AND (omni_dispatch_receipts.status <> 'cancelled' OR EXCLUDED.status = 'cancelled');
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt scope or state conflict'; END IF;
  INSERT INTO public.site_log(actor, action, category, status, summary, project_id, detail)
    VALUES(_actor::text, 'omni.dispatch.receipt', 'delivery', 'ok', 'Verified receive-only dispatch receipt', p.id,
      jsonb_build_object('jobId', j.id, 'grantId', g.id, 'kind', g.kind,
        'status', CASE _op WHEN 'record_cancelled' THEN 'cancelled' ELSE 'quarantined' END));
  RETURN jsonb_build_object('recorded', true);
END $$;

CREATE OR REPLACE FUNCTION public.omni_dispatch_issue_reviewed(
  _actor uuid, _job uuid, _step uuid, _project uuid, _repo text, _instructions text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j public.omni_jobs;
BEGIN
  SELECT * INTO j FROM public.omni_jobs WHERE id = _job FOR UPDATE;
  IF NOT FOUND OR j.project_id IS DISTINCT FROM _project OR j.repo IS DISTINCT FROM _repo
    OR j.instructions IS DISTINCT FROM _instructions OR j.kind NOT IN ('code', 'test')
    THEN RAISE EXCEPTION 'Reviewed job changed'; END IF;
  RETURN public.omni_dispatch_grant_action('issue', _actor, _job, _step);
END $$;

-- An explicit link failure, missing settings or a settings change revokes every live job approval.
-- Only a link that merely aged out leaves approvals in place; they stay unusable until the link is
-- fresh again because every use re-checks omni_link_live().
CREATE FUNCTION public.omni_link_lost_revoke() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  IF OLD.verified AND NOT NEW.verified
    AND NEW.last_error IS DISTINCT FROM 'OMNI verification expired; check the link again.' THEN
    UPDATE public.omni_dispatch_grants SET revoked_at = now() WHERE revoked_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      INSERT INTO public.site_log(actor, action, category, status, summary, detail)
        VALUES('jackboy', 'omni.dispatch.revoke', 'approval', 'blocked',
          'OMNI live link lost; job approvals revoked', jsonb_build_object('revokedJobApprovals', n));
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.omni_link_lost_revoke() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER omni_link_lost_revoke AFTER UPDATE OF verified ON public.omni_connection
  FOR EACH ROW EXECUTE FUNCTION public.omni_link_lost_revoke();
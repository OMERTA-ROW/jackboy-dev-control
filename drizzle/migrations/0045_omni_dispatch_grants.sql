-- Grants authorize future receipt only. They do not enable dispatch or execution.
CREATE TABLE public.omni_dispatch_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.omni_jobs(id),
  project_id uuid NOT NULL REFERENCES public.agent_projects(id),
  owner_id uuid NOT NULL,
  kind text NOT NULL,
  repo text NOT NULL,
  instructions text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX omni_dispatch_one_live_grant ON public.omni_dispatch_grants(job_id)
  WHERE revoked_at IS NULL;
CREATE TABLE public.omni_dispatch_receipts (
  job_id uuid PRIMARY KEY REFERENCES public.omni_jobs(id),
  grant_id uuid NOT NULL REFERENCES public.omni_dispatch_grants(id),
  status text NOT NULL CHECK (status IN ('quarantined', 'cancelled')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.omni_dispatch_callback_nonces (
  nonce text PRIMARY KEY CHECK (nonce ~ '^[a-f0-9]{32}$'),
  received_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.omni_dispatch_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_dispatch_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_dispatch_callback_nonces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.omni_dispatch_grants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.omni_dispatch_receipts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.omni_dispatch_callback_nonces FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.omni_dispatch_grants TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.omni_dispatch_receipts TO service_role;
GRANT SELECT, INSERT ON public.omni_dispatch_callback_nonces TO service_role;

CREATE FUNCTION public.omni_dispatch_grant_action(_op text, _actor uuid, _job uuid, _grant uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  j public.omni_jobs;
  p public.agent_projects;
  g public.omni_dispatch_grants;
  step public.step_up_grants;
  valid_grant boolean;
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
      OR j.kind <> 'test' OR j.repo IS NULL
      OR char_length(j.instructions) < 3 OR char_length(j.instructions) > 4000
      OR j.repo !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
      OR p.created_by <> _actor OR NOT p.enrolled
      OR p.repo_url IS DISTINCT FROM 'https://github.com/' || j.repo
      OR COALESCE((SELECT paused FROM public.automation_policy WHERE id = 1), true)
      THEN RAISE EXCEPTION 'Job scope unavailable'; END IF;
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
    INSERT INTO public.omni_dispatch_grants(job_id, project_id, owner_id, kind, repo, instructions, expires_at)
      VALUES(j.id, p.id, _actor, j.kind, j.repo, j.instructions, now() + interval '15 minutes')
      RETURNING * INTO g;
    INSERT INTO public.site_log(actor, action, category, status, summary, project_id, detail)
      VALUES(_actor::text, 'omni.dispatch.grant', 'approval', 'ok', 'Receive-only dispatch grant issued', p.id,
        jsonb_build_object('jobId', j.id, 'grantId', g.id));
    RETURN jsonb_build_object('id', g.id, 'expiresAt', g.expires_at,
      'ownerId', g.owner_id, 'projectId', g.project_id, 'jobId', g.job_id,
      'repo', g.repo, 'kind', g.kind, 'instructions', g.instructions);
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

  valid_grant := COALESCE(g.revoked_at IS NULL AND g.expires_at > now()
    AND g.project_id = j.project_id AND p.created_by = _actor AND p.enrolled
    AND p.repo_url = 'https://github.com/' || g.repo
    AND j.status = 'queued' AND j.sent_at IS NULL AND j.code_request_id IS NULL
    AND j.kind = g.kind AND j.repo = g.repo AND j.instructions = g.instructions
    AND NOT COALESCE((SELECT paused FROM public.automation_policy WHERE id = 1), true), false);
  IF _op = 'check' THEN
    IF NOT valid_grant THEN RETURN jsonb_build_object('valid', false); END IF;
    RETURN jsonb_build_object('valid', true, 'id', g.id, 'expiresAt', g.expires_at,
      'ownerId', g.owner_id, 'projectId', g.project_id, 'jobId', g.job_id,
      'repo', g.repo, 'kind', g.kind, 'instructions', g.instructions);
  END IF;
  IF NOT valid_grant THEN RAISE EXCEPTION 'Grant unavailable'; END IF;
  INSERT INTO public.omni_dispatch_receipts(job_id, grant_id, status)
    VALUES(j.id, g.id, CASE _op WHEN 'record_cancelled' THEN 'cancelled' ELSE 'quarantined' END)
    ON CONFLICT (job_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()
    WHERE omni_dispatch_receipts.grant_id = EXCLUDED.grant_id
      AND (omni_dispatch_receipts.status <> 'cancelled' OR EXCLUDED.status = 'cancelled');
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt scope or state conflict'; END IF;
  INSERT INTO public.site_log(actor, action, category, status, summary, project_id, detail)
    VALUES(_actor::text, 'omni.dispatch.receipt', 'delivery', 'ok', 'Verified receive-only dispatch receipt', p.id,
      jsonb_build_object('jobId', j.id, 'grantId', g.id, 'status', CASE _op WHEN 'record_cancelled' THEN 'cancelled' ELSE 'quarantined' END));
  RETURN jsonb_build_object('recorded', true);
END $$;
REVOKE ALL ON FUNCTION public.omni_dispatch_grant_action(text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_dispatch_grant_action(text, uuid, uuid, uuid) TO service_role;

-- A passkey confirms the exact preview, not a later edit to the queued job.
CREATE FUNCTION public.omni_dispatch_issue_reviewed(
  _actor uuid, _job uuid, _step uuid, _project uuid, _repo text, _instructions text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j public.omni_jobs;
BEGIN
  SELECT * INTO j FROM public.omni_jobs WHERE id = _job FOR UPDATE;
  IF NOT FOUND OR j.project_id IS DISTINCT FROM _project OR j.repo IS DISTINCT FROM _repo
    OR j.instructions IS DISTINCT FROM _instructions OR j.kind IS DISTINCT FROM 'test'
    THEN RAISE EXCEPTION 'Reviewed job changed'; END IF;
  RETURN public.omni_dispatch_grant_action('issue', _actor, _job, _step);
END $$;
REVOKE ALL ON FUNCTION public.omni_dispatch_issue_reviewed(uuid,uuid,uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_dispatch_issue_reviewed(uuid,uuid,uuid,uuid,text,text) TO service_role;

CREATE FUNCTION public.omni_dispatch_callback_record(
  _nonce text, _owner uuid, _project uuid, _job uuid, _grant uuid, _repo text, _status text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE g public.omni_dispatch_grants; receipt jsonb;
BEGIN
  IF _nonce IS NULL OR _nonce !~ '^[a-f0-9]{32}$'
    OR _status IS NULL OR _status NOT IN ('quarantined', 'cancelled')
    OR _owner IS NULL OR _project IS NULL OR _job IS NULL OR _grant IS NULL OR _repo IS NULL
    THEN RAISE EXCEPTION 'Invalid callback'; END IF;
  SELECT * INTO g FROM public.omni_dispatch_grants WHERE id = _grant;
  IF NOT FOUND OR g.owner_id IS DISTINCT FROM _owner OR g.project_id IS DISTINCT FROM _project
    OR g.job_id IS DISTINCT FROM _job OR g.repo IS DISTINCT FROM _repo
    THEN RAISE EXCEPTION 'Callback scope unavailable'; END IF;
  INSERT INTO public.omni_dispatch_callback_nonces(nonce) VALUES (_nonce) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RAISE EXCEPTION 'Callback replay'; END IF;
  receipt := public.omni_dispatch_grant_action('record_' || _status, _owner, _job, _grant);
  RETURN receipt;
END $$;
REVOKE ALL ON FUNCTION public.omni_dispatch_callback_record(text,uuid,uuid,uuid,uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_dispatch_callback_record(text,uuid,uuid,uuid,uuid,text,text) TO service_role;

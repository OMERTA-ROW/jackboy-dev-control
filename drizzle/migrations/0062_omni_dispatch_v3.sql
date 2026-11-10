-- V3 callbacks are tied to an immutable locally authorized scope. These rows are
-- deliberately separate from v2 receipts and callback nonces.
CREATE TABLE public.omni_dispatch_v3_jobs (
  job_id uuid PRIMARY KEY REFERENCES public.omni_jobs(id),
  grant_id uuid NOT NULL REFERENCES public.omni_dispatch_grants(id),
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES public.agent_projects(id),
  repo text NOT NULL CHECK (repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  kind text NOT NULL CHECK (kind IN ('build', 'test')),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN (
    'prepared', 'approved', 'quarantined', 'running',
    'completed', 'failed', 'expired', 'cancel_requested', 'cancelled'
  )),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (grant_id, job_id),
  CHECK (result IS NULL OR status IN ('completed', 'failed'))
);

CREATE TABLE public.omni_dispatch_v3_callback_nonces (
  nonce text PRIMARY KEY CHECK (nonce ~ '^[a-f0-9]{32}$'),
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.omni_dispatch_v3_callback_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES public.omni_dispatch_v3_jobs(job_id),
  status text NOT NULL CHECK (status IN (
    'quarantined', 'cancelled', 'running', 'completed', 'failed', 'expired'
  )),
  result jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, status),
  CHECK (
    (status IN ('completed', 'failed') AND result IS NOT NULL)
    OR (status NOT IN ('completed', 'failed') AND result IS NULL)
  )
);

ALTER TABLE public.omni_dispatch_v3_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_dispatch_v3_callback_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_dispatch_v3_callback_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.omni_dispatch_v3_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.omni_dispatch_v3_callback_nonces FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.omni_dispatch_v3_callback_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.omni_dispatch_v3_jobs TO service_role;
GRANT SELECT, INSERT ON public.omni_dispatch_v3_callback_nonces TO service_role;
GRANT SELECT, INSERT ON public.omni_dispatch_v3_callback_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.omni_dispatch_v3_callback_events_id_seq TO service_role;

CREATE FUNCTION public.guard_omni_dispatch_v3_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.grant_id IS DISTINCT FROM OLD.grant_id
    OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.repo IS DISTINCT FROM OLD.repo OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (OLD.status IN ('completed', 'failed', 'expired', 'cancelled')
      AND NEW.status IS DISTINCT FROM OLD.status)
    OR (OLD.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result)
    OR (NEW.result IS NOT NULL AND NEW.status NOT IN ('completed', 'failed'))
    THEN RAISE EXCEPTION 'V3 dispatch scope and stored results are immutable'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_omni_dispatch_v3_scope() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER omni_dispatch_v3_scope_immutable
  BEFORE UPDATE ON public.omni_dispatch_v3_jobs
  FOR EACH ROW EXECUTE FUNCTION public.guard_omni_dispatch_v3_scope();

CREATE FUNCTION public.omni_dispatch_v3_action(
  _op text,
  _actor uuid,
  _job uuid,
  _grant uuid,
  _project uuid,
  _repo text,
  _kind text,
  _digest text,
  _expires timestamptz,
  _action text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  g public.omni_dispatch_grants;
  r public.omni_dispatch_v3_jobs;
  current_grant jsonb;
BEGIN
  IF _actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _actor AND role = 'owner'
  ) THEN RAISE EXCEPTION 'Owner required'; END IF;

  IF _op = 'prepare' THEN
    IF _action <> 'submit' OR _project IS NULL OR _repo IS NULL
      OR _kind NOT IN ('build', 'test') OR _digest !~ '^[a-f0-9]{64}$'
      OR _expires IS NULL OR _expires <= now() OR _expires > now() + interval '30 minutes'
      THEN RAISE EXCEPTION 'Invalid v3 scope'; END IF;
    current_grant := public.omni_dispatch_grant_action('check', _actor, _job, _grant);
    IF COALESCE((current_grant->>'valid')::boolean, false) IS NOT TRUE
      THEN RAISE EXCEPTION 'Current owner grant unavailable'; END IF;
    SELECT * INTO g FROM public.omni_dispatch_grants
      WHERE id = _grant AND job_id = _job AND owner_id = _actor FOR UPDATE;
    IF NOT FOUND OR g.project_id IS DISTINCT FROM _project OR g.repo IS DISTINCT FROM _repo
      OR (CASE g.kind WHEN 'code' THEN 'build' ELSE g.kind END) IS DISTINCT FROM _kind
      OR _expires > g.expires_at OR NOT public.omni_link_live()
      THEN RAISE EXCEPTION 'Current v3 grant scope unavailable'; END IF;
    SELECT * INTO r FROM public.omni_dispatch_v3_jobs
      WHERE job_id = _job AND grant_id = _grant FOR UPDATE;
    IF FOUND THEN
      IF r.owner_id IS DISTINCT FROM _actor OR r.project_id IS DISTINCT FROM _project
        OR r.repo IS DISTINCT FROM _repo OR r.kind IS DISTINCT FROM _kind
        OR r.payload_digest IS DISTINCT FROM _digest OR r.expires_at IS DISTINCT FROM _expires
        OR r.status IN ('cancel_requested', 'cancelled', 'completed', 'failed', 'expired')
        THEN RAISE EXCEPTION 'V3 scope or state conflict'; END IF;
      RETURN jsonb_build_object('prepared', true);
    END IF;
    INSERT INTO public.omni_dispatch_v3_jobs(
      job_id, grant_id, owner_id, project_id, repo, kind, payload_digest, expires_at, status
    ) VALUES (_job, _grant, _actor, _project, _repo, _kind, _digest, _expires, 'prepared');
    RETURN jsonb_build_object('prepared', true);
  END IF;

  SELECT * INTO r FROM public.omni_dispatch_v3_jobs
    WHERE job_id = _job AND grant_id = _grant AND owner_id = _actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Previously authorized v3 scope unavailable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.omni_dispatch_grants
    WHERE id = r.grant_id AND job_id = r.job_id AND owner_id = r.owner_id)
    THEN RAISE EXCEPTION 'V3 grant scope unavailable'; END IF;

  IF _op = 'read' THEN
    RETURN jsonb_build_object(
      'ownerId', r.owner_id, 'projectId', r.project_id, 'grantId', r.grant_id,
      'jobId', r.job_id, 'repo', r.repo, 'kind', r.kind, 'payloadDigest', r.payload_digest
    );
  ELSIF _op IN ('authorize_status', 'request_cancel') THEN
    IF _project IS DISTINCT FROM r.project_id OR _repo IS DISTINCT FROM r.repo
      OR _kind IS DISTINCT FROM r.kind OR _digest IS DISTINCT FROM r.payload_digest
      THEN RAISE EXCEPTION 'V3 scope mismatch'; END IF;
    IF _op = 'request_cancel' AND r.status NOT IN ('completed', 'failed', 'expired', 'cancelled') THEN
      UPDATE public.omni_dispatch_v3_jobs SET status = 'cancel_requested', updated_at = now()
        WHERE job_id = r.job_id;
    END IF;
    RETURN jsonb_build_object('authorized', true);
  ELSIF _op = 'record_response' THEN
    IF _project IS DISTINCT FROM r.project_id OR _repo IS DISTINCT FROM r.repo
      OR _kind IS DISTINCT FROM r.kind OR _digest IS DISTINCT FROM r.payload_digest
      OR _action NOT IN ('approved', 'quarantined', 'running', 'completed', 'failed', 'expired', 'cancelled')
      THEN RAISE EXCEPTION 'Invalid v3 response state'; END IF;
    IF r.status NOT IN ('completed', 'failed', 'expired', 'cancelled')
      AND NOT (r.status = 'cancel_requested' AND _action IN ('approved', 'quarantined', 'running'))
      AND NOT (r.status = 'running' AND _action IN ('approved', 'quarantined'))
      AND NOT (r.status = 'quarantined' AND _action = 'approved') THEN
      UPDATE public.omni_dispatch_v3_jobs
        SET status = _action, updated_at = now()
        WHERE job_id = r.job_id;
    END IF;
    RETURN jsonb_build_object('recorded', true);
  END IF;
  RAISE EXCEPTION 'Invalid v3 operation';
END $$;
REVOKE ALL ON FUNCTION public.omni_dispatch_v3_action(text,uuid,uuid,uuid,uuid,text,text,text,timestamptz,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_dispatch_v3_action(text,uuid,uuid,uuid,uuid,text,text,text,timestamptz,text)
  TO service_role;

CREATE FUNCTION public.omni_dispatch_v3_pending_cancellations(_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF _actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _actor AND role = 'owner'
  ) THEN RAISE EXCEPTION 'Owner required'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('jobId', r.job_id, 'grantId', r.grant_id) ORDER BY r.created_at)
    FROM public.omni_dispatch_v3_jobs r
    JOIN public.omni_dispatch_grants g ON g.id = r.grant_id
    LEFT JOIN public.omni_project_authorizations a ON a.id = g.authorization_id
    WHERE r.owner_id = _actor
      AND r.status IN ('prepared', 'approved', 'quarantined', 'running', 'cancel_requested')
      AND (r.expires_at <= now() OR g.revoked_at IS NOT NULL OR g.expires_at <= now()
        OR a.id IS NULL OR a.revoked_at IS NOT NULL OR a.expires_at <= now())
  ), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.omni_dispatch_v3_pending_cancellations(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_dispatch_v3_pending_cancellations(uuid) TO service_role;

CREATE FUNCTION public.omni_dispatch_v3_callback_record(
  _nonce text,
  _owner uuid,
  _project uuid,
  _job uuid,
  _grant uuid,
  _repo text,
  _digest text,
  _status text,
  _result jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r public.omni_dispatch_v3_jobs;
  prior public.omni_dispatch_v3_callback_events;
BEGIN
  IF _nonce IS NULL OR _nonce !~ '^[a-f0-9]{32}$'
    OR _status NOT IN ('quarantined', 'cancelled', 'running', 'completed', 'failed', 'expired')
    OR _owner IS NULL OR _project IS NULL OR _job IS NULL OR _grant IS NULL
    OR _repo IS NULL OR _digest !~ '^[a-f0-9]{64}$'
    THEN RAISE EXCEPTION 'Invalid v3 callback'; END IF;
  IF _status IN ('completed', 'failed') THEN
    IF _result IS NULL OR jsonb_typeof(_result) IS DISTINCT FROM 'object'
      OR _result - ARRAY['passed', 'summary', 'output', 'truncated'] <> '{}'::jsonb
      OR NOT (_result ?& ARRAY['passed', 'summary', 'output', 'truncated'])
      OR jsonb_typeof(_result->'passed') <> 'boolean'
      OR jsonb_typeof(_result->'truncated') <> 'boolean'
      OR jsonb_typeof(_result->'summary') <> 'string'
      OR jsonb_typeof(_result->'output') <> 'string'
      OR char_length(_result->>'summary') > 500
      OR octet_length(_result->>'output') > 6144
      OR (_status = 'completed' AND (_result->>'passed')::boolean IS NOT TRUE)
      OR (_status = 'failed' AND (_result->>'passed')::boolean IS NOT FALSE)
      THEN RAISE EXCEPTION 'Invalid terminal v3 result'; END IF;
  ELSIF _result IS NOT NULL THEN
    RAISE EXCEPTION 'Nonterminal v3 callback cannot include a result';
  END IF;

  SELECT * INTO r FROM public.omni_dispatch_v3_jobs
    WHERE job_id = _job AND grant_id = _grant AND owner_id = _owner FOR UPDATE;
  IF NOT FOUND OR r.project_id IS DISTINCT FROM _project OR r.repo IS DISTINCT FROM _repo
    OR r.payload_digest IS DISTINCT FROM _digest
    THEN RAISE EXCEPTION 'V3 callback scope unavailable'; END IF;
  IF EXISTS (SELECT 1 FROM public.omni_dispatch_v3_callback_nonces WHERE nonce = _nonce)
    THEN RAISE EXCEPTION 'Callback nonce replay'; END IF;
  INSERT INTO public.omni_dispatch_v3_callback_nonces(nonce) VALUES (_nonce);

  INSERT INTO public.omni_dispatch_v3_callback_events(job_id, status, result)
    VALUES (_job, _status, _result) ON CONFLICT (job_id, status) DO NOTHING;
  IF NOT FOUND THEN
    SELECT * INTO prior FROM public.omni_dispatch_v3_callback_events
      WHERE job_id = _job AND status = _status FOR UPDATE;
    IF prior.result IS DISTINCT FROM _result
      THEN RAISE EXCEPTION 'V3 logical callback conflict'; END IF;
  END IF;

  IF r.status IN ('completed', 'failed', 'expired', 'cancelled') THEN
    IF r.status = _status AND _status IN ('completed', 'failed') AND r.result IS NULL THEN
      UPDATE public.omni_dispatch_v3_jobs SET result = _result, updated_at = now()
        WHERE job_id = _job;
    END IF;
  ELSIF r.status = 'cancel_requested' AND _status IN ('completed', 'failed', 'expired', 'cancelled') THEN
    UPDATE public.omni_dispatch_v3_jobs SET
      status = _status,
      result = CASE WHEN _status IN ('completed', 'failed') THEN _result ELSE result END,
      updated_at = now()
      WHERE job_id = _job;
  ELSIF r.status <> 'cancel_requested'
    AND NOT (r.status = 'running' AND _status = 'quarantined') THEN
    UPDATE public.omni_dispatch_v3_jobs SET
      status = _status,
      result = CASE WHEN _status IN ('completed', 'failed') THEN _result ELSE result END,
      updated_at = now()
      WHERE job_id = _job;
  END IF;
  RETURN jsonb_build_object('recorded', true);
END $$;
REVOKE ALL ON FUNCTION public.omni_dispatch_v3_callback_record(text,uuid,uuid,uuid,uuid,text,text,text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_dispatch_v3_callback_record(text,uuid,uuid,uuid,uuid,text,text,text,jsonb)
  TO service_role;

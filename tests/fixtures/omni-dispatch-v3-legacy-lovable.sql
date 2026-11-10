-- Historical test fixture, NOT an application migration.
-- Source: 8312c3e39f2ea8e0eca7007c0a7840665277d660 (lovable-sync-1794272803).
-- Exact 0062 lines 4-24, followed by exact 0064 lines 9-126.
CREATE TABLE public.omni_dispatch_v3_jobs (
  job_id uuid PRIMARY KEY REFERENCES public.omni_jobs(id),
  grant_id uuid NOT NULL REFERENCES public.omni_dispatch_grants(id),
  owner_id uuid NOT NULL,
  project_id uuid NOT NULL,
  repo text NOT NULL,
  status text NOT NULL CHECK (status IN ('quarantined', 'approved', 'running', 'completed', 'failed', 'cancelled', 'expired')),
  result jsonb,
  result_at timestamptz,
  last_source text NOT NULL CHECK (last_source IN ('dispatch', 'callback')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (result IS NULL OR status IN ('completed', 'failed')),
  CHECK ((result IS NULL) = (result_at IS NULL))
);
REVOKE ALL ON public.omni_dispatch_v3_jobs FROM PUBLIC, anon;
GRANT SELECT ON public.omni_dispatch_v3_jobs TO authenticated;
GRANT ALL ON public.omni_dispatch_v3_jobs TO service_role;
ALTER TABLE public.omni_dispatch_v3_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads v3 dispatch status" ON public.omni_dispatch_v3_jobs
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'));
CREATE FUNCTION public.omni_dispatch_v3_callback_scope(_owner uuid, _job uuid, _grant uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  g public.omni_dispatch_grants;
BEGIN
  IF _owner IS NULL OR _job IS NULL OR _grant IS NULL THEN RETURN jsonb_build_object('found', false); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _owner AND role = 'owner') THEN
    RETURN jsonb_build_object('found', false);
  END IF;
  SELECT * INTO g FROM public.omni_dispatch_grants WHERE id = _grant AND job_id = _job AND owner_id = _owner;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.omni_dispatch_v3_jobs v
    WHERE v.job_id = _job AND v.grant_id = g.id AND v.owner_id = g.owner_id
      AND v.project_id = g.project_id AND v.repo = g.repo
  ) THEN RETURN jsonb_build_object('found', false); END IF;
  RETURN jsonb_build_object('found', true, 'id', g.id, 'ownerId', g.owner_id, 'projectId', g.project_id,
    'jobId', g.job_id, 'repo', g.repo, 'kind', g.kind, 'instructions', g.instructions);
END $$;
REVOKE ALL ON FUNCTION public.omni_dispatch_v3_callback_scope(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_dispatch_v3_callback_scope(uuid, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.omni_dispatch_v3_record(
  _source text, _nonce text, _owner uuid, _project uuid, _job uuid, _grant uuid, _repo text,
  _status text, _result jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  g public.omni_dispatch_grants;
  cur public.omni_dispatch_v3_jobs;
  checked jsonb;
  rank_new int;
  rank_cur int;
  result_callback boolean;
BEGIN
  IF _source IS NULL OR _source NOT IN ('dispatch', 'callback')
    OR _owner IS NULL OR _project IS NULL OR _job IS NULL OR _grant IS NULL OR _repo IS NULL
    OR _status IS NULL
    THEN RAISE EXCEPTION 'Invalid v3 dispatch record'; END IF;
  IF _source = 'callback' AND (_nonce IS NULL OR _nonce !~ '^[a-f0-9]{32}$'
    OR _status NOT IN ('quarantined', 'cancelled', 'running', 'completed', 'failed', 'expired'))
    THEN RAISE EXCEPTION 'Invalid v3 callback'; END IF;
  IF _source = 'dispatch' AND (_nonce IS NOT NULL OR _result IS NOT NULL
    OR _status NOT IN ('quarantined', 'approved', 'running', 'completed', 'failed', 'cancelled', 'expired'))
    THEN RAISE EXCEPTION 'Invalid v3 dispatch receipt'; END IF;
  IF _result IS NOT NULL THEN
    IF _status NOT IN ('completed', 'failed') OR jsonb_typeof(_result) <> 'object'
      THEN RAISE EXCEPTION 'Invalid v3 result'; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(_result)) <> 4
      OR NOT (_result ?& ARRAY['passed', 'summary', 'output', 'truncated'])
      OR jsonb_typeof(_result->'passed') <> 'boolean'
      OR jsonb_typeof(_result->'truncated') <> 'boolean'
      OR jsonb_typeof(_result->'summary') <> 'string'
      OR jsonb_typeof(_result->'output') <> 'string'
      THEN RAISE EXCEPTION 'Invalid v3 result'; END IF;
    IF char_length(_result->>'summary') > 500 OR octet_length(_result->>'output') > 6144
      THEN RAISE EXCEPTION 'Invalid v3 result'; END IF;
  END IF;
  result_callback := _source = 'callback' AND _status IN ('running', 'completed', 'failed', 'cancelled', 'expired');

  SELECT * INTO g FROM public.omni_dispatch_grants WHERE id = _grant;
  IF NOT FOUND OR g.owner_id IS DISTINCT FROM _owner OR g.project_id IS DISTINCT FROM _project
    OR g.job_id IS DISTINCT FROM _job OR g.repo IS DISTINCT FROM _repo
    THEN RAISE EXCEPTION 'v3 dispatch scope unavailable'; END IF;
  IF _source = 'callback' THEN
    INSERT INTO public.omni_dispatch_callback_nonces(nonce) VALUES (_nonce) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN RAISE EXCEPTION 'Callback replay'; END IF;
  END IF;
  IF result_callback THEN
    -- Results may arrive after the approval window; the owner must still hold the owner role.
    IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _owner AND role = 'owner') THEN
      RAISE EXCEPTION 'Owner required';
    END IF;
  ELSE
    checked := public.omni_dispatch_grant_action('check', _owner, _job, _grant);
    IF (checked->>'valid') IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'Grant unavailable: %', COALESCE(checked->>'reason', 'unknown');
    END IF;
  END IF;

  rank_new := CASE _status WHEN 'quarantined' THEN 1 WHEN 'approved' THEN 2 WHEN 'running' THEN 3 ELSE 4 END;
  SELECT * INTO cur FROM public.omni_dispatch_v3_jobs WHERE job_id = _job FOR UPDATE;
  IF FOUND THEN
    IF cur.grant_id <> _grant OR cur.owner_id <> _owner OR cur.project_id <> _project OR cur.repo <> _repo
      THEN RAISE EXCEPTION 'v3 dispatch grant conflict'; END IF;
    rank_cur := CASE cur.status WHEN 'quarantined' THEN 1 WHEN 'approved' THEN 2 WHEN 'running' THEN 3 ELSE 4 END;
    IF rank_new < rank_cur THEN
      -- An older state arriving late never overwrites a newer one.
      RETURN jsonb_build_object('recorded', true, 'status', cur.status, 'changed', false);
    END IF;
    IF rank_cur = 4 THEN
      IF cur.status <> _status THEN RAISE EXCEPTION 'v3 dispatch state conflict'; END IF;
      IF _result IS NULL OR _result = cur.result THEN
        RETURN jsonb_build_object('recorded', true, 'status', cur.status, 'changed', false);
      END IF;
      IF cur.result IS NOT NULL THEN RAISE EXCEPTION 'v3 dispatch result conflict'; END IF;
    END IF;
    UPDATE public.omni_dispatch_v3_jobs SET
      status = _status,
      result = _result,
      result_at = CASE WHEN _result IS NULL THEN NULL ELSE now() END,
      last_source = _source,
      updated_at = now()
      WHERE job_id = _job;
  ELSIF _source = 'callback' THEN
    -- Only Jackboy's own v3 submit creates the job row; a callback never creates one.
    RAISE EXCEPTION 'v3 job was not submitted';
  ELSE
    INSERT INTO public.omni_dispatch_v3_jobs(job_id, grant_id, owner_id, project_id, repo, status, result, result_at, last_source)
      VALUES (_job, _grant, _owner, _project, _repo, _status, _result,
        CASE WHEN _result IS NULL THEN NULL ELSE now() END, _source);
  END IF;
  INSERT INTO public.site_log(actor, action, category, status, summary, project_id, detail)
    VALUES (_owner::text, 'omni.dispatch.v3', 'delivery', 'ok', 'OMNI v3 job status: ' || _status, _project,
      jsonb_build_object('jobId', _job, 'grantId', _grant, 'status', _status, 'source', _source,
        'passed', _result->'passed'));
  RETURN jsonb_build_object('recorded', true, 'status', _status, 'changed', true);
END $$;
REVOKE ALL ON FUNCTION public.omni_dispatch_v3_record(text, text, uuid, uuid, uuid, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_dispatch_v3_record(text, text, uuid, uuid, uuid, uuid, text, text, jsonb) TO service_role;

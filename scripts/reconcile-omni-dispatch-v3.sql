-- Operator-only alternate entrypoint for pending 0062, never a later migration.
-- See docs/OMNI-DISPATCH-V3.md. Execute this WHOLE FILE in one fresh session,
-- preserving transaction statements; never execute statements independently.
-- On any error, stop and roll back. Not idempotent or safe to rerun.
BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $reconcile$
DECLARE
  legacy oid;
  f record;
  obj record;
  expected_name text;
  suffix constant text := '_legacy_lovable';
BEGIN
  legacy := pg_catalog.to_regclass('public.omni_dispatch_v3_jobs');
  IF legacy IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
    WHERE oid = legacy AND relkind = 'r' AND NOT relispartition
  ) THEN
    RAISE EXCEPTION 'Reconciliation requires the ordinary legacy public.omni_dispatch_v3_jobs table';
  END IF;

  -- Hold the emptiness check, dependency inspection and rename under one lock
  -- until all of 0062 commits; concurrent inserts/DDL cannot slip between them.
  LOCK TABLE ONLY public.omni_dispatch_v3_jobs IN ACCESS EXCLUSIVE MODE;
  IF legacy IS DISTINCT FROM pg_catalog.to_regclass('public.omni_dispatch_v3_jobs') THEN
    RAISE EXCEPTION 'Legacy table changed while acquiring the lock';
  END IF;
  -- RLS must not turn a nonempty table into an apparently empty one.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user
      AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'Reconciliation requires an operator that bypasses RLS';
  END IF;
  IF EXISTS (SELECT 1 FROM public.omni_dispatch_v3_jobs) THEN
    RAISE EXCEPTION 'Legacy omni_dispatch_v3_jobs is not empty; reconciliation refused';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid = legacy OR inhparent = legacy
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = legacy AND attnum > 0 AND attisdropped
  ) OR (
    SELECT array_agg(attname::text ORDER BY attname)
    FROM pg_catalog.pg_attribute
    WHERE attrelid = legacy AND attnum > 0 AND NOT attisdropped
  ) IS DISTINCT FROM ARRAY[
    'created_at', 'grant_id', 'job_id', 'last_source', 'owner_id', 'project_id',
    'repo', 'result', 'result_at', 'status', 'updated_at'
  ]::text[] THEN
    RAISE EXCEPTION 'Unsupported legacy table columns or inheritance';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = legacy AND attnum > 0 AND (
      atttypid <> CASE
        WHEN attname IN ('job_id', 'grant_id', 'owner_id', 'project_id') THEN 'uuid'::regtype
        WHEN attname IN ('created_at', 'updated_at', 'result_at') THEN 'timestamptz'::regtype
        WHEN attname = 'result' THEN 'jsonb'::regtype
        ELSE 'text'::regtype END
      OR atttypmod <> -1 OR attgenerated <> '' OR attidentity <> ''
    )
  ) THEN
    RAISE EXCEPTION 'Unsupported legacy column types, generated columns or identity';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = legacy AND c.contype = 'p'
      AND c.conkey = ARRAY[(
        SELECT attnum FROM pg_catalog.pg_attribute
        WHERE attrelid = legacy AND attname = 'job_id'
      )]::smallint[]
  ) THEN
    RAISE EXCEPTION 'Unsupported legacy primary key';
  END IF;
  IF pg_catalog.to_regclass('public.omni_dispatch_v3_jobs_legacy_lovable') IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
        AND t.typname IN ('omni_dispatch_v3_jobs_legacy_lovable', '_omni_dispatch_v3_jobs_legacy_lovable')
    )
  THEN
    RAISE EXCEPTION 'Legacy table/type suffix collision';
  END IF;
  -- PostgreSQL can silently pick a different identity sequence/index name on
  -- collision. 0062 grants the exact sequence name, so refuse instead.
  FOREACH expected_name IN ARRAY ARRAY[
    'omni_dispatch_v3_callback_nonces', 'omni_dispatch_v3_callback_nonces_pkey',
    'omni_dispatch_v3_callback_events', 'omni_dispatch_v3_callback_events_pkey',
    'omni_dispatch_v3_callback_events_job_id_status_key', 'omni_dispatch_v3_callback_events_id_seq'
  ] LOOP
    IF pg_catalog.to_regclass(pg_catalog.format('public.%I', expected_name)) IS NOT NULL THEN
      RAISE EXCEPTION '0062 relation name collision: %', expected_name;
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname IN (
      'omni_dispatch_v3_callback_nonces', '_omni_dispatch_v3_callback_nonces',
      'omni_dispatch_v3_callback_events', '_omni_dispatch_v3_callback_events'
    )
  ) THEN
    RAISE EXCEPTION '0062 type name collision';
  END IF;

  -- Catalog-bound dependencies would keep pointing at the archived table.
  -- Textual/dynamic callers cannot be established here; operator review is required.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid = legacy AND NOT tgisinternal
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid = legacy
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class = legacy
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend
    WHERE classid IN ('pg_catalog.pg_rewrite'::regclass, 'pg_catalog.pg_proc'::regclass)
      AND (
        (refclassid = 'pg_catalog.pg_class'::regclass AND refobjid = legacy)
        OR (refclassid = 'pg_catalog.pg_type'::regclass AND refobjid IN (
          SELECT t.oid FROM pg_catalog.pg_type t
          WHERE t.typrelid = legacy OR t.typelem = (SELECT reltype FROM pg_catalog.pg_class WHERE oid = legacy)
        ))
      )
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class c ON c.oid = d.objid
    WHERE d.refclassid = 'pg_catalog.pg_class'::regclass AND d.refobjid = legacy
      AND d.classid = 'pg_catalog.pg_class'::regclass AND c.relkind = 'S'
  ) THEN
    RAISE EXCEPTION 'Unsupported legacy trigger, incoming FK, rule, dependent function/view or owned sequence';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend
    WHERE classid = 'pg_catalog.pg_class'::regclass AND objid = legacy AND deptype = 'e'
  ) THEN
    RAISE EXCEPTION 'Extension-owned legacy table is unsupported';
  END IF;

  FOR obj IN SELECT * FROM (VALUES
    ('omni_jobs', ARRAY['id']),
    ('agent_projects', ARRAY['id']),
    ('user_roles', ARRAY['user_id', 'role']),
    ('omni_dispatch_grants', ARRAY[
      'id', 'job_id', 'owner_id', 'project_id', 'repo', 'kind', 'expires_at', 'revoked_at', 'authorization_id'
    ]),
    ('omni_project_authorizations', ARRAY['id', 'expires_at', 'revoked_at'])
  ) AS prerequisites(table_name, columns) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = obj.table_name AND c.relkind = 'r'
    ) OR EXISTS (
      SELECT 1 FROM unnest(obj.columns) AS required(column_name)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid = pg_catalog.to_regclass(pg_catalog.format('public.%I', obj.table_name))
          AND attname = required.column_name AND attnum > 0 AND NOT attisdropped
          AND (
            (required.column_name = 'role' AND (
              atttypid = 'text'::regtype OR atttypid = pg_catalog.to_regtype('public.app_role')
            ))
            OR (required.column_name <> 'role' AND atttypid = CASE
              WHEN required.column_name IN ('repo', 'kind') THEN 'text'::regtype
              WHEN required.column_name IN ('expires_at', 'revoked_at') THEN 'timestamptz'::regtype
              ELSE 'uuid'::regtype END)
          )
      )
    ) THEN
      RAISE EXCEPTION 'Missing or incompatible 0062 prerequisite columns: public.%', obj.table_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = pg_catalog.to_regprocedure('public.omni_link_live()')
      AND prokind = 'f' AND prorettype = 'boolean'::regtype AND NOT proretset
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = pg_catalog.to_regprocedure('public.omni_dispatch_grant_action(text,uuid,uuid,uuid)')
      AND prokind = 'f' AND prorettype = 'jsonb'::regtype AND NOT proretset
  ) THEN
    RAISE EXCEPTION 'Missing or incompatible 0062 prerequisite functions';
  END IF;

  FOREACH expected_name IN ARRAY ARRAY[
    'omni_dispatch_v3_record', 'omni_dispatch_v3_callback_scope'
  ] LOOP
    IF (
      SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = expected_name
    ) <> 1 THEN
      RAISE EXCEPTION 'Missing or ambiguous legacy function public.%', expected_name;
    END IF;
    SELECT p.*, pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_args
      INTO STRICT f
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = expected_name;
    -- Signatures are evidenced by Lovable source 8312c3e (historical 0064).
    IF f.prokind <> 'f' OR f.prorettype <> 'jsonb'::regtype OR f.proretset
      OR f.oid IS DISTINCT FROM pg_catalog.to_regprocedure(
        CASE expected_name
          WHEN 'omni_dispatch_v3_record'
            THEN 'public.omni_dispatch_v3_record(text,text,uuid,uuid,uuid,uuid,text,text,jsonb)'
          ELSE 'public.omni_dispatch_v3_callback_scope(uuid,uuid,uuid)' END
      )
      OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend
        WHERE classid = 'pg_catalog.pg_proc'::regclass AND objid = f.oid AND deptype = 'e'
      )
    THEN
      RAISE EXCEPTION 'Incompatible legacy function public.%', expected_name;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = expected_name || suffix
    ) THEN
      RAISE EXCEPTION 'Legacy function suffix collision: %', expected_name;
    END IF;
  END LOOP;

  -- Table renames do not rename indexes. Move only the two names needed by
  -- 0062, and only if they belong to this legacy table; never touch unrelated objects.
  FOREACH expected_name IN ARRAY ARRAY[
    'omni_dispatch_v3_jobs_pkey', 'omni_dispatch_v3_jobs_grant_id_job_id_key'
  ] LOOP
    IF pg_catalog.to_regclass('public.' || expected_name) IS NOT NULL THEN
      SELECT c.oid, c.relname, con.oid AS constraint_oid, con.conname INTO obj
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid AND i.indrelid = legacy
      LEFT JOIN pg_catalog.pg_constraint con ON con.conindid = c.oid AND con.conrelid = legacy
      WHERE c.oid = pg_catalog.to_regclass('public.' || expected_name);
      IF NOT FOUND THEN
        RAISE EXCEPTION '0062 index name belongs to an unrelated object: %', expected_name;
      END IF;
      IF pg_catalog.to_regclass(pg_catalog.format('public.%I', expected_name || suffix)) IS NOT NULL
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_constraint
          WHERE conrelid = legacy AND conname = expected_name || suffix
        )
      THEN
        RAISE EXCEPTION 'Legacy index/constraint suffix collision: %', expected_name;
      END IF;
      IF obj.constraint_oid IS NOT NULL THEN
        EXECUTE pg_catalog.format('ALTER TABLE public.omni_dispatch_v3_jobs RENAME CONSTRAINT %I TO %I',
          obj.conname, expected_name || suffix);
      ELSE
        EXECUTE pg_catalog.format('ALTER INDEX public.%I RENAME TO %I', expected_name, expected_name || suffix);
      END IF;
    END IF;
  END LOOP;

  ALTER TABLE public.omni_dispatch_v3_jobs RENAME TO omni_dispatch_v3_jobs_legacy_lovable;
  FOREACH expected_name IN ARRAY ARRAY[
    'omni_dispatch_v3_record', 'omni_dispatch_v3_callback_scope'
  ] LOOP
    SELECT p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_args INTO STRICT f
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = expected_name;
    EXECUTE pg_catalog.format('ALTER FUNCTION public.%I(%s) RENAME TO %I',
      f.proname, f.identity_args, f.proname || suffix);
  END LOOP;
END
$reconcile$;

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
COMMIT;

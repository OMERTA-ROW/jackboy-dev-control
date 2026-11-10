-- Operator-only follow-up for Lovable's SQL runner; never a migration, never a rerun of 0062.
-- Run the WHOLE FILE in one fresh session after scripts/reconcile-omni-dispatch-v3.sql
-- committed. It only records the canonical 0062 in drizzle.__drizzle_migrations and
-- revokes the identity sequence from non-service roles. See docs/OMNI-DISPATCH-V3.md.
-- hash = sha256 of drizzle/migrations/0062_omni_dispatch_v3.sql;
-- created_at = journal `when` of 0062_omni_dispatch_v3 (tests/omni-dispatch-v3-history.test.mjs).
-- Any unexpected state raises and rolls the whole transaction back.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $record$
DECLARE
  expected_hash constant text := '3d9e882b8cec18835456220c126d08d489037a61a5cc5bdf1b218bc06af3a3bf';
  expected_when constant bigint := 1794285308000;
  jobs_columns constant text[] := ARRAY[
    'created_at', 'expires_at', 'grant_id', 'job_id', 'kind', 'owner_id',
    'payload_digest', 'project_id', 'repo', 'result', 'status', 'updated_at'
  ];
  sig text;
  seq oid;
  history oid;
BEGIN
  history := pg_catalog.to_regclass('drizzle.__drizzle_migrations');
  IF history IS NULL THEN
    RAISE EXCEPTION 'drizzle.__drizzle_migrations is missing';
  END IF;
  IF (
    SELECT array_agg(attname::text || ':' || atttypid::regtype::text ORDER BY attname)
    FROM pg_catalog.pg_attribute
    WHERE attrelid = history AND attnum > 0 AND NOT attisdropped
  ) IS DISTINCT FROM ARRAY['created_at:bigint', 'hash:text', 'id:integer']::text[] THEN
    RAISE EXCEPTION 'Unsupported drizzle.__drizzle_migrations shape';
  END IF;

  -- Hold history steady between the checks and the insert.
  LOCK TABLE drizzle.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = expected_hash) THEN
    RAISE EXCEPTION '0062 hash is already recorded; refusing to insert';
  END IF;
  -- The migrator skips entries not newer than the latest row; a row at or after
  -- 0062's timestamp is a conflict, never something to rewrite here.
  IF EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at >= expected_when) THEN
    RAISE EXCEPTION 'Conflicting history: a row exists at or after the 0062 timestamp';
  END IF;

  IF (
    SELECT count(*) FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relispartition
      AND c.relname IN (
        'omni_dispatch_v3_jobs', 'omni_dispatch_v3_callback_nonces',
        'omni_dispatch_v3_callback_events'
      )
  ) <> 3 THEN
    RAISE EXCEPTION '0062 tables are not all present';
  END IF;
  IF (
    SELECT array_agg(attname::text ORDER BY attname)
    FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.omni_dispatch_v3_jobs'::regclass
      AND attnum > 0 AND NOT attisdropped
  ) IS DISTINCT FROM jobs_columns THEN
    RAISE EXCEPTION 'omni_dispatch_v3_jobs does not have the 0062 columns';
  END IF;

  FOREACH sig IN ARRAY ARRAY[
    'public.guard_omni_dispatch_v3_scope()',
    'public.omni_dispatch_v3_action(text,uuid,uuid,uuid,uuid,text,text,text,timestamptz,text)',
    'public.omni_dispatch_v3_pending_cancellations(uuid)',
    'public.omni_dispatch_v3_callback_record(text,uuid,uuid,uuid,uuid,text,text,text,jsonb)'
  ] LOOP
    IF pg_catalog.to_regprocedure(sig) IS NULL THEN
      RAISE EXCEPTION '0062 function % is missing', sig;
    END IF;
  END LOOP;

  seq := pg_catalog.to_regclass('public.omni_dispatch_v3_callback_events_id_seq');
  IF seq IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class WHERE oid = seq AND relkind = 'S'
  ) THEN
    RAISE EXCEPTION '0062 callback events sequence is missing';
  END IF;

  INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
    VALUES (expected_hash, expected_when);
END $record$;

REVOKE ALL ON SEQUENCE public.omni_dispatch_v3_callback_events_id_seq
  FROM PUBLIC, anon, authenticated;

COMMIT;

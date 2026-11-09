-- Run only through an already-authorized production database connection.
-- Catalog evidence only: no application RPC, secret/decryption view or job command.
\set ON_ERROR_STOP on
\pset pager off
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';
SET LOCAL TIME ZONE 'UTC';

SELECT 'identity' AS section, transaction_timestamp() AS captured_at_utc,
  current_database() AS database_name, current_user AS reader_role,
  current_setting('server_version') AS server_version,
  current_setting('transaction_read_only') AS read_only,
  pg_is_in_recovery() AS is_replica;

-- A database name/version is not a provider project identity. Bind this result
-- to the authenticated provider inventory and connection record out of band.
SELECT 'journal' AS section, id, hash, created_at,
  to_timestamp(created_at / 1000.0) AS migration_timestamp
FROM drizzle.__drizzle_migrations ORDER BY created_at, id;

WITH expected(tag, hash, stamp) AS (VALUES
  ('0058_omni_link_approval_save', 'd2d3c52f7815dabec1902fbade337a86a7c6bb58a07b803fed1dbf3703c0253e', 1794127942788::bigint),
  ('0059_sync_safety_guards', 'b8b9c452658a6cd54da7cd8e4866274098b2dfbef7eb05239650ea676cd06fef', 1794199693289::bigint),
  ('0060_code_acceptance_guard_verification', '453f95f477865ad0a6d662bc81a87eba9590f894c6b177e904bc0ce7fe911d44', 1794215442298::bigint)
)
SELECT 'journal_comparison' AS section, tag,
  (SELECT count(*) FROM drizzle.__drizzle_migrations j
    WHERE j.hash=e.hash AND j.created_at=e.stamp) AS exact_rows,
  (SELECT count(*) FROM drizzle.__drizzle_migrations j
    WHERE j.created_at=e.stamp AND j.hash<>e.hash) AS conflicting_timestamp_rows
FROM expected e ORDER BY stamp;

WITH expected(signature) AS (VALUES
  ('public.set_guardian_limits(integer,integer,integer)'),
  ('public.guard_code_acceptance_reservation()'),
  ('public.code_acceptance_guard_status()'),
  ('public.claim_code_runtime_slot(uuid,text,text,text,bigint)'),
  ('public.code_total_spend_guard_status()'),
  ('public.code_total_spend_guard_enforced()'),
  ('public.code_total_spend_guard_trigger()'),
  ('public.code_spend_meter_status()'),
  ('public.enable_code_runtime(uuid)')
)
SELECT 'function_catalog' AS section, e.signature, p.oid IS NOT NULL AS present,
  pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer,
  md5(pg_get_functiondef(p.oid)) AS definition_md5,
  p.proconfig @> ARRAY['search_path=""']::text[] AS empty_search_path,
  has_function_privilege('anon',p.oid,'EXECUTE') AS anon_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') AS service_execute,
  EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.signature)
ORDER BY e.signature;

SELECT 'reservation_triggers' AS section, t.tgname,
  p.oid::regprocedure::text AS function_signature, t.tgtype, t.tgenabled,
  t.tgisinternal, t.tgqual IS NULL AS unconditional,
  t.tgnargs, t.tgconstraint=0 AS non_constraint,
  md5(pg_get_triggerdef(t.oid)) AS definition_md5,
  (t.tgname='code_acceptance_reservation_guard'
    AND t.tgfoid=to_regprocedure('public.guard_code_acceptance_reservation()')
    AND t.tgtype=7 AND t.tgenabled='O' AND NOT t.tgisinternal
    AND t.tgqual IS NULL AND t.tgnargs=0 AND t.tgconstraint=0) AS exact_acceptance_shape
FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
WHERE t.tgrelid='public.code_spend_reservations'::regclass
ORDER BY t.tgname;

SELECT 'other_safety_triggers' AS section, n.nspname, c.relname, t.tgname,
  t.tgfoid::regprocedure::text AS function_signature, t.tgtype, t.tgenabled,
  md5(pg_get_triggerdef(t.oid)) AS definition_md5
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND NOT t.tgisinternal
  AND c.relname IN ('code_runtime_controls','code_usage_events','code_provider_calls','audit_logs')
ORDER BY c.relname,t.tgname;

SELECT 'controls' AS section, singleton, enabled, kill_switch,
  active_request_id IS NOT NULL AS active_request,
  active_run_id IS NOT NULL AS active_run, consecutive_failures, usage_spike,
  per_task_reserve_usd, daily_spend_limit_usd, total_spend_limit_usd,
  provider_hard_cap_verified, provider_usage_at, cancellation_status,
  stop_requested_at IS NOT NULL AS stop_requested
FROM public.code_runtime_controls;
SELECT 'global_pause' AS section, id, paused FROM public.automation_policy;
SELECT 'reservations' AS section, status, count(*) AS rows,
  sum(reserved_usd) AS reserved_usd, sum(released_usd) AS released_usd,
  min(created_at) AS oldest, max(created_at) AS newest
FROM public.code_spend_reservations GROUP BY status ORDER BY status;

SELECT 'constraints' AS section, c.relname, con.conname, con.convalidated,
  md5(pg_get_constraintdef(con.oid)) AS definition_md5
FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
WHERE con.connamespace='public'::regnamespace
  AND c.relname IN ('code_runtime_controls','code_spend_reservations')
ORDER BY c.relname,con.conname;
SELECT 'public_constraint_totals' AS section,
  count(*) FILTER(WHERE convalidated) AS validated,
  count(*) FILTER(WHERE NOT convalidated) AS unvalidated
FROM pg_constraint WHERE connamespace='public'::regnamespace;

SELECT 'reader_completeness' AS section, rolname, rolsuper, rolbypassrls
FROM pg_roles WHERE rolname=current_user;
SELECT 'rls' AS section, c.relname, c.relrowsecurity, c.relforcerowsecurity,
  has_table_privilege(current_user,c.oid,'SELECT') AS reader_can_select
FROM pg_class c WHERE c.oid IN (
  'public.code_runtime_controls'::regclass,'public.code_spend_reservations'::regclass,
  'public.automation_policy'::regclass);
SELECT 'extensions' AS section, extname, extversion FROM pg_extension
WHERE extname IN ('pg_cron','supabase_vault','pg_net','pgcrypto','uuid-ossp')
ORDER BY extname;
SELECT 'realtime_catalog' AS section, p.oid::regprocedure::text AS signature,
  pg_get_userbyid(p.proowner) AS owner, md5(pg_get_functiondef(p.oid)) AS definition_md5
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='realtime' AND p.prokind='f' ORDER BY signature;

ROLLBACK;

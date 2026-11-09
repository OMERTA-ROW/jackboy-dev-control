-- Verification only: no schema objects or data change. Runs after 0059 and 0060 in the
-- same transaction; any failed assertion rolls back all three together.
DO $$
DECLARE
  c record;
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.set_guardian_limits(integer,integer,integer)',
    'public.guard_code_acceptance_reservation()',
    'public.code_acceptance_guard_status()',
    'public.claim_code_runtime_slot(uuid,text,text,text,bigint)'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      WHERE p.oid = pg_catalog.to_regprocedure(f)
        AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres'
        AND p.prosecdef
        AND p.proconfig @> ARRAY['search_path=""']::text[]
        AND NOT pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
    ) THEN
      RAISE EXCEPTION 'Post-install check failed for %', f;
    END IF;
  END LOOP;
  IF pg_catalog.has_function_privilege('authenticated', 'public.code_acceptance_guard_status()'::regprocedure, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', 'public.guard_code_acceptance_reservation()'::regprocedure, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', 'public.claim_code_runtime_slot(uuid,text,text,text,bigint)'::regprocedure, 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('service_role', 'public.code_acceptance_guard_status()'::regprocedure, 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('service_role', 'public.claim_code_runtime_slot(uuid,text,text,text,bigint)'::regprocedure, 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege('authenticated', 'public.set_guardian_limits(integer,integer,integer)'::regprocedure, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'Post-install permission check failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.code_spend_reservations'::regclass
      AND tgname = 'code_acceptance_reservation_guard'
      AND tgfoid = 'public.guard_code_acceptance_reservation()'::regprocedure
      AND tgenabled = 'O' AND NOT tgisinternal AND tgtype = 7
      AND tgqual IS NULL AND tgnargs = 0 AND tgconstraint = 0
  ) THEN
    RAISE EXCEPTION 'Acceptance reservation trigger is missing or has the wrong shape';
  END IF;
  SELECT * INTO c FROM public.code_runtime_controls WHERE singleton = true;
  IF NOT FOUND OR c.enabled IS DISTINCT FROM false OR c.kill_switch IS DISTINCT FROM true
    OR c.active_request_id IS NOT NULL OR c.active_run_id IS NOT NULL
    OR c.per_task_reserve_usd <> 1.00 OR c.daily_spend_limit_usd <> 5.00 OR c.total_spend_limit_usd <> 10.00
  THEN
    RAISE EXCEPTION 'CODE must stay off and stopped with $1/$5/$10 limits';
  END IF;
  IF EXISTS (SELECT 1 FROM public.code_spend_reservations WHERE status = 'reserved') THEN
    RAISE EXCEPTION 'Unexpected money hold present';
  END IF;
END;
$$;
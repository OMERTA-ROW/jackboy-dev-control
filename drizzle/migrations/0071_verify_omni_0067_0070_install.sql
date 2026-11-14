-- Verification-only record for installing 0067-0070 (writes nothing). Drizzle applies the pending 0067-0070
-- files and this entry in one transaction, so any failed check below rolls all of them back.
DO $$
DECLARE c record;
BEGIN
  -- Install only while CODE cannot start: Emergency Stop engaged or CODE off, and nothing in flight.
  SELECT * INTO c FROM public.code_runtime_controls WHERE singleton = true;
  IF c.singleton IS DISTINCT FROM true
     OR NOT (c.kill_switch IS TRUE OR c.enabled IS FALSE)
     OR c.active_request_id IS NOT NULL OR c.active_run_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.code_spend_reservations WHERE status <> 'settled')
     OR EXISTS (SELECT 1 FROM public.code_provider_calls WHERE status IN ('admitted','dispatched','unknown'))
     OR EXISTS (SELECT 1 FROM public.omni_execution_permits WHERE status = 'active')
  THEN RAISE EXCEPTION '0067-0070 install refused: CODE is not stopped or work is in flight'; END IF;
  -- Objects from 0067-0070 exist.
  IF to_regclass('public.omni_execution_connections') IS NULL OR to_regclass('public.omni_execution_jobs') IS NULL
     OR to_regclass('public.omni_permit_safety_generation') IS NULL
     OR to_regprocedure('public.omni_execution_permit_action_unlocked(text,jsonb)') IS NULL
     OR to_regprocedure('public.omni_execution_permit_action_without_worker(text,jsonb)') IS NULL
     OR to_regprocedure('public.omni_execution_permit_action_without_safety_generation(text,jsonb)') IS NULL
     OR to_regprocedure('public.omni_execution_control_without_lease(uuid,uuid,uuid,text,jsonb)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
                    AND table_name='omni_execution_permits' AND column_name='stop_generation')
     OR (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('omni_permit_generation_stamp',
          'omni_permit_generation_code','omni_permit_generation_global','omni_execution_permit_closed',
          'omni_execution_code_stop','omni_execution_global_stop','omni_execution_job_guard')) <> 7
  THEN RAISE EXCEPTION '0067-0070 install incomplete'; END IF;
  -- Server-only: no browser role can call the permit or execution authority.
  IF has_function_privilege('anon','public.omni_execution_permit_action(text,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','public.omni_execution_permit_action(text,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','public.omni_execution_control(uuid,uuid,uuid,text,jsonb)','EXECUTE')
     OR has_function_privilege('authenticated','public.omni_execution_permit_action_unlocked(text,jsonb)','EXECUTE')
     OR has_function_privilege('service_role','public.omni_execution_permit_action_unlocked(text,jsonb)','EXECUTE')
     OR NOT has_function_privilege('service_role','public.omni_execution_permit_action(text,jsonb)','EXECUTE')
     OR has_table_privilege('authenticated','public.omni_execution_jobs','SELECT')
  THEN RAISE EXCEPTION '0067-0070 permissions are not server-only'; END IF;
END $$;
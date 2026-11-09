-- All synthetic rows and drift probes roll back. Never enable CODE, even in rehearsal.
BEGIN;
DO $$
DECLARE
  request_id uuid := gen_random_uuid();
  owner_id uuid;
  result boolean;
BEGIN
  IF NOT public.code_acceptance_guard_status()
    OR NOT public.code_total_spend_guard_enforced() THEN
    RAISE EXCEPTION 'Spending guards not verified';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.code_spend_reservations'::regclass
      AND tgname='code_acceptance_reservation_guard'
      AND tgfoid='public.guard_code_acceptance_reservation()'::regprocedure
      AND tgtype=7 AND tgenabled='O' AND NOT tgisinternal
      AND tgqual IS NULL AND tgnargs=0 AND tgconstraint=0)
    OR EXISTS(SELECT 1 FROM pg_proc WHERE oid IN (
      'public.code_acceptance_guard_status()'::regprocedure,
      'public.set_guardian_limits(integer,integer,integer)'::regprocedure,
      'public.claim_code_runtime_slot(uuid,text,text,text,bigint)'::regprocedure)
      AND (pg_get_userbyid(proowner)<>'postgres' OR NOT prosecdef))
  THEN RAISE EXCEPTION 'Trigger identity or migration ownership mismatch'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.code_runtime_controls
    WHERE enabled=false AND kill_switch=true AND active_request_id IS NULL
      AND active_run_id IS NULL AND daily_spend_limit_usd=5 AND total_spend_limit_usd=10)
    OR NOT EXISTS (SELECT 1 FROM public.automation_policy WHERE id=1 AND paused=true)
    OR EXISTS (SELECT 1 FROM public.code_spend_reservations) THEN
    RAISE EXCEPTION 'Stopped, empty rehearsal state required';
  END IF;
  IF has_function_privilege('authenticated','public.claim_code_runtime_slot(uuid,text,text,text,bigint)','EXECUTE')
    OR has_function_privilege('anon','public.claim_code_runtime_slot(uuid,text,text,text,bigint)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.claim_code_runtime_slot(uuid,text,text,text,bigint)','EXECUTE')
    OR has_function_privilege('authenticated','public.code_acceptance_guard_status()','EXECUTE')
    OR has_function_privilege('anon','public.code_acceptance_guard_status()','EXECUTE')
    OR NOT has_function_privilege('service_role','public.code_acceptance_guard_status()','EXECUTE')
    OR has_function_privilege('anon','public.set_guardian_limits(integer,integer,integer)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.set_guardian_limits(integer,integer,integer)','EXECUTE')
  THEN RAISE EXCEPTION 'RPC privilege mismatch'; END IF;

  ALTER TABLE public.code_spend_reservations DISABLE TRIGGER code_acceptance_reservation_guard;
  IF public.code_acceptance_guard_status() THEN RAISE EXCEPTION 'Disabled trigger accepted'; END IF;
  ALTER TABLE public.code_spend_reservations ENABLE TRIGGER code_acceptance_reservation_guard;
  DROP TRIGGER code_acceptance_reservation_guard ON public.code_spend_reservations;
  CREATE TRIGGER code_acceptance_reservation_guard BEFORE UPDATE ON public.code_spend_reservations
    FOR EACH ROW EXECUTE FUNCTION public.guard_code_acceptance_reservation();
  IF public.code_acceptance_guard_status() THEN RAISE EXCEPTION 'Wrong event accepted'; END IF;
  DROP TRIGGER code_acceptance_reservation_guard ON public.code_spend_reservations;
  CREATE TRIGGER code_acceptance_reservation_guard BEFORE INSERT ON public.code_spend_reservations
    FOR EACH ROW EXECUTE FUNCTION public.guard_code_acceptance_reservation();

  SELECT user_id INTO owner_id FROM public.user_roles WHERE role='owner';
  IF owner_id IS NULL THEN RAISE EXCEPTION 'Restored owner absent'; END IF;
  INSERT INTO public.action_requests(id,action,tier,nonce_hash,expires_at,requested_by,status,
    runner_claimed_at,runner_run_id,runner_run_attempt,resources)
    VALUES(request_id,'code','high','isolated-rehearsal',now()+interval '1 hour',owner_id,'allowed',
      now(),900000001,1,
      '{"acceptance":true,"repo":"OMERTA-ROW/jackboy-dev-control","ref":"main","taskBudgetUsd":1}');
  result := public.claim_code_runtime_slot(request_id,'OMERTA-ROW/jackboy-dev-control','main',repeat('a',40),900000001);
  IF result IS DISTINCT FROM false OR EXISTS(SELECT 1 FROM public.code_spend_reservations) THEN
    RAISE EXCEPTION 'Stopped runtime admitted a claim';
  END IF;
  BEGIN
    INSERT INTO public.code_spend_reservations(request_id,run_id,reserved_usd)
      VALUES(request_id,900000001,1.01);
    RAISE EXCEPTION 'Acceptance above $1 accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Acceptance%' THEN RAISE; END IF;
  END;
  BEGIN
    INSERT INTO public.code_spend_reservations(request_id,run_id,reserved_usd)
      VALUES(request_id,900000001,1);
    IF public.code_total_spend_committed() <> 1 THEN RAISE EXCEPTION 'Hold not counted'; END IF;
    RAISE EXCEPTION 'rollback synthetic hold';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'rollback synthetic hold' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.code_runtime_controls SET daily_spend_limit_usd=5.01;
    RAISE EXCEPTION 'Daily ceiling could be raised above $5';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.code_runtime_controls SET total_spend_limit_usd=10.01;
    RAISE EXCEPTION 'Cumulative ceiling could be raised above $10';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO public.code_usage_events(provider_event_id,source,occurred_at,cost_usd)
    VALUES('isolated-rehearsal-total','openai_org_costs',now()-interval '3 days',10);
  IF public.code_total_spend_committed() <> 10 THEN RAISE EXCEPTION 'Prior-day cost not counted'; END IF;
  BEGIN
    INSERT INTO public.code_spend_reservations(request_id,run_id,reserved_usd)
      VALUES(request_id,900000001,1);
    RAISE EXCEPTION 'Cumulative ceiling failed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'CODE total spend guard:%' THEN RAISE; END IF;
  END;
  IF EXISTS(SELECT 1 FROM public.code_spend_reservations) THEN RAISE EXCEPTION 'Failed hold persisted'; END IF;
END;
$$;
ROLLBACK;

-- Rollback for 0042_code_provider_gateway.sql. Refuses while any provider call is unresolved, so an
-- in-flight or uncertain call can never be forgotten. Engage Emergency Stop first. Export
-- code_provider_calls beforehand if its history must be kept. 0037 is never modified.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.code_provider_calls WHERE status IN ('admitted', 'dispatched', 'unknown')) THEN
    RAISE EXCEPTION 'Unresolved CODE provider calls exist; resolve them before rolling back';
  END IF;
END;
$$;
DROP FUNCTION public.reconcile_code_provider_day(uuid, date, numeric);
DROP FUNCTION public.resolve_code_provider_call(uuid, uuid, numeric, text);
DROP FUNCTION public.settle_code_provider_call(uuid, numeric, text);
DROP FUNCTION public.apply_code_provider_call_cost(uuid, numeric, text, text);
DROP FUNCTION public.mark_code_provider_call_unknown(uuid, text);
DROP FUNCTION public.abort_code_provider_call(uuid, text);
DROP FUNCTION public.dispatch_code_provider_call(uuid);
DROP FUNCTION public.admit_code_provider_call(uuid, bigint, text, text, numeric);
DROP FUNCTION public.code_provider_call_holds(uuid);
DROP TRIGGER code_provider_calls_guard ON public.code_provider_calls;
DROP TABLE public.code_provider_calls;
DROP FUNCTION public.guard_code_provider_call();

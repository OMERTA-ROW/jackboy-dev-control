-- Rollback for 0041_code_spend_hold_release.sql. Removes the closed-day evidence table and the
-- owner hold-release function. Refuses while unsettled reservations exist, so no hold can be
-- orphaned from the evidence process. 0037 provider_hard_cap_verified = false is never touched.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.code_spend_reservations WHERE status <> 'settled') THEN
    RAISE EXCEPTION 'Unsettled CODE spend reservations exist; reconcile or release them before rolling back';
  END IF;
END;
$$;
DROP FUNCTION public.release_code_spend_holds(uuid, uuid[], text);
DROP FUNCTION public.record_code_closed_day_costs(uuid, date, jsonb, timestamptz);
DROP TRIGGER code_provider_cost_day_reports_guard ON public.code_provider_cost_day_reports;
DROP TABLE public.code_provider_cost_day_reports;
DROP FUNCTION public.guard_code_provider_cost_day_report();
ALTER TABLE public.code_runtime_controls DROP COLUMN closed_day_lag_seconds;

-- REVIEW-ONLY STAGING ROLLBACK. Never add to the normal migration chain.
DO $$
DECLARE
  marker_count bigint;
  controls public.code_runtime_controls%ROWTYPE;
BEGIN
  IF pg_catalog.to_regclass('public.jackboy_staging_identity') IS NULL THEN
    RAISE EXCEPTION 'Staging identity marker is missing';
  END IF;
  LOCK TABLE public.jackboy_staging_identity IN SHARE MODE;
  SELECT count(*) INTO marker_count
  FROM public.jackboy_staging_identity
  WHERE environment_id = '83515d1e-141f-4fd1-8dfb-50764a73a5db'::uuid
    AND service_id = 'f0c879d1-1934-4b5b-b4e6-728bc807d51d'::uuid;
  IF marker_count <> 1 OR (SELECT count(*) FROM public.jackboy_staging_identity) <> 1 THEN
    RAISE EXCEPTION 'Staging identity marker does not match';
  END IF;

  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  IF NOT FOUND OR controls.enabled IS DISTINCT FROM false
    OR controls.kill_switch IS DISTINCT FROM true
    OR controls.provider_hard_cap_verified IS DISTINCT FROM false
    OR controls.active_request_id IS NOT NULL OR controls.active_run_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'CODE must be disabled and stopped with the cap flag false';
  END IF;
  IF pg_catalog.to_regclass('public.code_spend_reservations') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.code_spend_reservations WHERE status <> 'settled') THEN
      RAISE EXCEPTION 'Unsettled CODE reservations prevent rollback';
    END IF;
  END IF;
  ALTER TABLE public.code_runtime_controls
    ADD CONSTRAINT code_runtime_controls_provider_hard_cap_verified_check
    CHECK (provider_hard_cap_verified = false);
END;
$$;

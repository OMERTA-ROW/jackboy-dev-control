-- Forward-only staging patch. Back up the database before applying this file.
-- Preserve the existing CODE enable/stop values; only add source-compatible guard state.
BEGIN;
DO $preflight$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Apply as postgres after the approved staging backup';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.code_runtime_controls
    WHERE singleton IS TRUE AND enabled IS FALSE AND kill_switch IS TRUE
      AND active_request_id IS NULL AND active_run_id IS NULL
  ) THEN
    RAISE EXCEPTION 'CODE controls are not in the reviewed disabled/stopped/no-active-work state';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.code_runtime_controls'::regclass
      AND attname IN ('total_spend_limit_usd', 'spend_meter') AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'CODE spend-guard columns already exist; stop and reconcile before applying';
  END IF;
END;
$preflight$;

ALTER TABLE public.code_runtime_controls
  ADD COLUMN total_spend_limit_usd numeric(10,2) NOT NULL DEFAULT 10.00;
ALTER TABLE public.code_runtime_controls
  ADD COLUMN spend_meter jsonb;
ALTER TABLE ONLY public.code_runtime_controls
  ADD CONSTRAINT code_runtime_controls_total_spend_limit_usd_check
  CHECK (((total_spend_limit_usd > (0)::numeric) AND (total_spend_limit_usd <= 10.00)));

COMMIT;

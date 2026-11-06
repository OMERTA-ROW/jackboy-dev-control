-- Reject rollback while the simulated flag is true.
DO $$
BEGIN
  IF pg_catalog.version() NOT LIKE '%(PGlite %wasm32-unknown-emscripten%' THEN
    RAISE EXCEPTION 'CODE local staging rollback requires PGlite';
  END IF;
  ALTER TABLE public.code_runtime_controls
    ADD CONSTRAINT code_runtime_controls_provider_hard_cap_verified_check
    CHECK (provider_hard_cap_verified = false);
END;
$$;

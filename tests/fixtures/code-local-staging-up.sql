-- PGlite-only test fixture. Never include this in a hosted migration chain.
DO $$
BEGIN
  IF pg_catalog.version() NOT LIKE '%(PGlite %wasm32-unknown-emscripten%' THEN
    RAISE EXCEPTION 'CODE local staging migration requires PGlite';
  END IF;
  ALTER TABLE public.code_runtime_controls
    DROP CONSTRAINT code_runtime_controls_provider_hard_cap_verified_check;
END;
$$;

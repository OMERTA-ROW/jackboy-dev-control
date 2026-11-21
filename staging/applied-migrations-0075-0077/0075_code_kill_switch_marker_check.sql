DO $$
BEGIN
  IF NOT public.code_independent_controls_installed() THEN
    RAISE EXCEPTION '0075 check failed: code_independent_controls_installed() is not true';
  END IF;
END
$$;
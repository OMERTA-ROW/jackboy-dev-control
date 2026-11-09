-- Limit-only Guardian updates must never rewrite a concurrently engaged pause.
CREATE FUNCTION public.set_guardian_limits(_tier int, _max_files int, _max_lines int)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE current_pause boolean;
BEGIN
  IF public.has_role(auth.uid(), 'owner') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Only the owner can change Guardian settings';
  END IF;
  IF _tier IS NULL OR _tier NOT BETWEEN 0 AND 2
    OR _max_files IS NULL OR _max_files NOT BETWEEN 1 AND 20
    OR _max_lines IS NULL OR _max_lines NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Invalid Guardian limits';
  END IF;
  UPDATE public.automation_policy
    SET tier = _tier, max_files = _max_files, max_lines = _max_lines,
        updated_by = auth.uid(), updated_at = now()
    WHERE id = 1 RETURNING paused INTO current_pause;
  IF NOT FOUND THEN RAISE EXCEPTION 'Automation policy unavailable'; END IF;
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (auth.uid(), 'automation.policy',
      jsonb_build_object('tier', _tier, 'paused', current_pause,
        'max_files', _max_files, 'max_lines', _max_lines), 'ok');
END;
$$;
REVOKE ALL ON FUNCTION public.set_guardian_limits(int, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_guardian_limits(int, int, int) TO authenticated;
--> statement-breakpoint
-- Runs inside the existing admission transaction, against the actual hold.
CREATE FUNCTION public.guard_code_acceptance_reservation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE scope jsonb; budget numeric;
BEGIN
  SELECT resources INTO scope FROM public.action_requests WHERE id = NEW.request_id;
  IF scope->>'acceptance' = 'true' THEN
    IF jsonb_typeof(scope->'taskBudgetUsd') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Acceptance budget unavailable';
    END IF;
    budget := (scope->>'taskBudgetUsd')::numeric;
    IF scope->>'repo' IS DISTINCT FROM 'OMERTA-ROW/jackboy-dev-control'
      OR scope->>'ref' IS DISTINCT FROM 'main'
      OR coalesce(scope->>'lane', 'reviewed') <> 'reviewed'
      OR budget <= 0 OR budget > 1 OR NEW.reserved_usd > budget
      OR NEW.reserved_usd <= 0 OR NEW.reserved_usd > 1 THEN
      RAISE EXCEPTION 'Acceptance scope or reservation exceeds owner approval';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_code_acceptance_reservation() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER code_acceptance_reservation_guard
  BEFORE INSERT ON public.code_spend_reservations
  FOR EACH ROW EXECUTE FUNCTION public.guard_code_acceptance_reservation();
--> statement-breakpoint
CREATE FUNCTION public.code_acceptance_guard_status()
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.code_spend_reservations'::regclass
      AND tgname = 'code_acceptance_reservation_guard'
      AND tgfoid = 'public.guard_code_acceptance_reservation()'::regprocedure
      AND tgenabled = 'O' AND NOT tgisinternal
  );
$$;
REVOKE ALL ON FUNCTION public.code_acceptance_guard_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.code_acceptance_guard_status() TO service_role;

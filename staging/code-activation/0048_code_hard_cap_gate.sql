-- APPLIED Nov 7, 2026 00:27 UTC on owner approval as drizzle/migrations/0047_code_hard_cap_gate.sql (only the header comment differs). Kept for review history.
-- Depends on 0047_code_total_spend_guard.sql (refuses to run without it).
--
-- Replaces 0037's forced-false CHECK (provider_hard_cap_verified = false) with a reviewed gate:
--   * the flag stays false by default and after this migration;
--   * it can become true ONLY through set_code_provider_hard_cap_verified(owner, true, evidence),
--     and only while the cumulative $10 guard reports enforced, CODE is disabled, the kill switch is
--     engaged and no task is active. Setting it never enables CODE or releases the Emergency Stop;
--   * a BEFORE trigger rejects every other false -> true change (raw UPDATE/INSERT), and rejects even
--     the owner function if the guard is missing or tampered with;
--   * turning the flag false is always allowed and never blocked, so a stop can never fail on it;
--   * claim and provider-call admission re-check the guard on every call (0047), so if a guard
--     trigger is later dropped or disabled CODE blocks even while the flag is true.
-- Trust boundary: the service role and database owner can still alter triggers. This gate stops
-- application paths and accidental writes; it is not protection against a compromised service role.

DO $$
BEGIN
  IF pg_catalog.to_regprocedure('public.code_total_spend_guard_enforced()') IS NULL THEN
    RAISE EXCEPTION 'Apply 0047_code_total_spend_guard first';
  END IF;
  IF EXISTS (SELECT 1 FROM public.code_runtime_controls WHERE provider_hard_cap_verified) THEN
    RAISE EXCEPTION 'provider_hard_cap_verified must be false before the gate is installed';
  END IF;
END;
$$;

CREATE FUNCTION public.code_runtime_controls_hard_cap_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.provider_hard_cap_verified IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.provider_hard_cap_verified IS TRUE THEN
    -- Already verified: other columns (kill switch, pauses, usage) must always be writable.
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('jackboy.code_hard_cap_attestation', true), '') <> 'owner-attested' THEN
    RAISE EXCEPTION 'provider_hard_cap_verified can only be set by set_code_provider_hard_cap_verified';
  END IF;
  IF NOT public.code_total_spend_guard_enforced() THEN
    RAISE EXCEPTION 'provider_hard_cap_verified requires the cumulative spend guard to be enforced';
  END IF;
  IF NEW.total_spend_limit_usd IS NULL OR NEW.total_spend_limit_usd > 10.00
    OR NEW.enabled IS DISTINCT FROM false
    OR NEW.kill_switch IS DISTINCT FROM true
    OR NEW.active_request_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'provider_hard_cap_verified can only be set while CODE is disabled and stopped';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER code_runtime_controls_hard_cap_gate
  BEFORE INSERT OR UPDATE ON public.code_runtime_controls
  FOR EACH ROW EXECUTE FUNCTION public.code_runtime_controls_hard_cap_gate();

ALTER TABLE public.code_runtime_controls
  DROP CONSTRAINT code_runtime_controls_provider_hard_cap_verified_check;

COMMENT ON COLUMN public.code_runtime_controls.provider_hard_cap_verified IS
  'True only after owner attestation through set_code_provider_hard_cap_verified while the cumulative spend guard (0047) is enforced. Default false.';

CREATE FUNCTION public.set_code_provider_hard_cap_verified(
  p_actor uuid,
  p_verified boolean,
  p_evidence text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  guard jsonb;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only the owner can change the CODE hard-cap verification';
  END IF;
  IF p_verified IS NULL THEN
    RAISE EXCEPTION 'A verification value is required';
  END IF;
  IF p_evidence IS NULL OR char_length(btrim(p_evidence)) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'Describe the evidence for this change (10 to 500 characters)';
  END IF;
  PERFORM 1 FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  guard := public.code_total_spend_guard_status();
  IF p_verified AND NOT coalesce((guard->>'enforced')::boolean, false) THEN
    RAISE EXCEPTION 'The cumulative spend guard is not enforced: %', guard->'missing';
  END IF;
  PERFORM pg_catalog.set_config('jackboy.code_hard_cap_attestation', 'owner-attested', true);
  UPDATE public.code_runtime_controls
    SET provider_hard_cap_verified = p_verified,
        updated_at = now()
    WHERE singleton = true;
  PERFORM pg_catalog.set_config('jackboy.code_hard_cap_attestation', '', true);
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (p_actor,
      CASE WHEN p_verified THEN 'code.hard_cap_verified' ELSE 'code.hard_cap_unverified' END,
      jsonb_build_object('evidence', left(btrim(p_evidence), 500), 'guard', guard),
      'ok');
  RETURN guard;
END;
$$;

REVOKE ALL ON FUNCTION public.code_runtime_controls_hard_cap_gate() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_code_provider_hard_cap_verified(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_code_provider_hard_cap_verified(uuid, boolean, text) TO service_role;

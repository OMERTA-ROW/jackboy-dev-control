-- Owner-only DemonTech enablement, enforced in the database (owner-approved install).
-- Why: authenticated managers (and the sandbox's read/insert role, which bypasses row security)
-- can write public.agent_projects directly, skipping updateProject's owner-only check.
-- Rule: turning demontech_enabled on (INSERT with true, or UPDATE false -> true) is allowed only for
--   (a) a signed-in user who holds the owner role, or
--   (b) trusted server maintenance: no signed-in user AND no anon/authenticated request claim AND the
--       statement runs as service_role/postgres/supabase_admin AND (a service_role request claim OR
--       a session that did not log in through the Data API's authenticator role).
-- A missing user id alone is never treated as trusted. Turning it off, keeping it on and every other
-- column are unaffected. No rows are changed. Idempotent and all-or-nothing.

CREATE OR REPLACE FUNCTION public.agent_projects_demontech_owner_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO ''
AS $$
DECLARE
  v_uid uuid;
  v_claim_role text;
BEGIN
  -- Only a change that turns DemonTech on is checked.
  IF NOT coalesce(NEW.demontech_enabled, false) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.demontech_enabled IS TRUE THEN
    RETURN NEW;
  END IF;

  v_uid := auth.uid();
  v_claim_role := coalesce(auth.role(), '');

  -- Trusted server maintenance (invoker rights: current_user is the role running the statement).
  -- Data API requests log in as authenticator; from there only a service_role claim is trusted.
  IF v_uid IS NULL
     AND v_claim_role NOT IN ('anon', 'authenticated')
     AND current_user IN ('service_role', 'postgres', 'supabase_admin')
     AND (v_claim_role = 'service_role' OR session_user <> 'authenticator') THEN
    RETURN NEW;
  END IF;

  IF v_uid IS NOT NULL AND public.has_role(v_uid, 'owner'::public.app_role) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Only the owner can authorize DemonTech checks.' USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.agent_projects_demontech_owner_only() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE TRIGGER agent_projects_demontech_owner_only
  BEFORE INSERT OR UPDATE ON public.agent_projects
  FOR EACH ROW EXECUTE FUNCTION public.agent_projects_demontech_owner_only();

DO $$
DECLARE
  f oid := 'public.agent_projects_demontech_owner_only()'::regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.agent_projects'::regclass
      AND tgname = 'agent_projects_demontech_owner_only'
      AND tgfoid = f AND tgenabled = 'O' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'demontech owner-only trigger missing or disabled after install';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = f) THEN
    RAISE EXCEPTION 'demontech owner-only function must run with invoker rights';
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'demontech owner-only function must not be callable by clients';
  END IF;
  IF position('current_user IN (''service_role'', ''postgres'', ''supabase_admin'')' IN (SELECT prosrc FROM pg_proc WHERE oid = f)) = 0 THEN
    RAISE EXCEPTION 'demontech owner-only function body is not the reviewed version';
  END IF;
END $$;

-- Staged, NOT applied. Needs owner approval as a forward migration (next free number after the
-- newest applied history row).
-- Why: authenticated managers have table UPDATE/INSERT on public.agent_projects, so an admin could
-- set demontech_enabled = true directly through the database API and skip updateProject's
-- owner-only check. This trigger enforces the same rule in the database: only the owner may turn
-- DemonTech on. Managers may still turn it off and edit every other column. Server-side admin
-- writes (no signed-in user) are unaffected. Idempotent, all-or-nothing.

CREATE OR REPLACE FUNCTION public.agent_projects_demontech_owner_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF auth.uid() IS NOT NULL
     AND NEW.demontech_enabled
     AND (TG_OP = 'INSERT' OR NOT OLD.demontech_enabled)
     AND NOT public.has_role(auth.uid(), 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only the owner can authorize DemonTech checks.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.agent_projects_demontech_owner_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS agent_projects_demontech_owner_only ON public.agent_projects;
CREATE TRIGGER agent_projects_demontech_owner_only
  BEFORE INSERT OR UPDATE OF demontech_enabled ON public.agent_projects
  FOR EACH ROW EXECUTE FUNCTION public.agent_projects_demontech_owner_only();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.agent_projects'::regclass
      AND tgname = 'agent_projects_demontech_owner_only' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'demontech owner-only trigger missing after install';
  END IF;
END $$;

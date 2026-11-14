-- DRAFT ONLY. NOT INSTALLED. NOT IN THE DRIZZLE JOURNAL.
-- Needs separate, specific owner approval before it is installed anywhere.
--
-- Follow-up to 0064_omni_configuration_probe. It changes only one thing: the
-- read-only runner configuration check is no longer refused while the global
-- Kill Switch (automation_policy.paused) is on, so configuration can be
-- attested without turning the Kill Switch off.
--
-- Unchanged: the owner role, active owned project, client ID/nonce format,
-- per-client lock, 10-minute nonce window, 60-per-10-minutes cap, single-use
-- nonce, one audit row per accepted check, SECURITY DEFINER with an empty
-- search_path, and service_role-only EXECUTE. The function still never creates
-- sessions, jobs, grants or approvals, and every execution entry point keeps
-- its own Kill Switch check (global-pause.server.ts).
CREATE OR REPLACE FUNCTION public.omni_link_configuration_authorize(
  _client_id text, _project_id uuid, _owner_id uuid, _nonce text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE _paused boolean;
BEGIN
  IF _client_id IS NULL OR _client_id !~ '^[a-zA-Z0-9_-]{1,64}$'
     OR _nonce IS NULL OR _nonce !~ '^[a-f0-9]{32}$'
     OR NOT EXISTS (
       SELECT 1 FROM public.owner_projects
       WHERE id = _project_id AND created_by = _owner_id AND active
     )
     OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _owner_id AND role = 'owner')
  THEN RETURN false; END IF;
  _paused := COALESCE((SELECT paused FROM public.automation_policy WHERE id = 1), true);
  PERFORM pg_advisory_xact_lock(hashtextextended('omni-config:' || _client_id, 0));
  DELETE FROM public.omni_callback_nonces
    WHERE starts_with(nonce, 'link-config:' || _client_id || ':') AND received_at < now() - interval '10 minutes';
  IF (SELECT count(*) FROM public.omni_callback_nonces
      WHERE starts_with(nonce, 'link-config:' || _client_id || ':')) >= 60
  THEN RETURN false; END IF;
  INSERT INTO public.omni_callback_nonces(nonce)
    VALUES ('link-config:' || _client_id || ':' || _nonce) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.site_log(actor, action, category, status, summary, project_id)
    VALUES ('omni-link', 'omni.link.configuration_check', 'config', 'info',
            CASE WHEN _paused
              THEN 'Authenticated read-only runner configuration check while Kill Switch is on (no execution)'
              ELSE 'Authenticated read-only runner configuration check' END,
            _project_id);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.omni_link_configuration_authorize(text, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_link_configuration_authorize(text, uuid, uuid, text) TO service_role;

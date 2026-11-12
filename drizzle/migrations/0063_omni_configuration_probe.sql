-- Metadata authorization never issues a session, job or execution approval.
CREATE FUNCTION public.omni_link_configuration_authorize(
  _client_id text, _project_id uuid, _owner_id uuid, _nonce text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF _client_id IS NULL OR _client_id !~ '^[a-zA-Z0-9_-]{1,64}$'
     OR _nonce IS NULL OR _nonce !~ '^[a-f0-9]{32}$'
     OR NOT EXISTS (
       SELECT 1 FROM public.owner_projects
       WHERE id = _project_id AND created_by = _owner_id AND active
     )
     OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _owner_id AND role = 'owner')
     OR COALESCE((SELECT paused FROM public.automation_policy WHERE id = 1), true)
  THEN RETURN false; END IF;
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
            'Authenticated read-only runner configuration check', _project_id);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.omni_link_configuration_authorize(text, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_link_configuration_authorize(text, uuid, uuid, text) TO service_role;

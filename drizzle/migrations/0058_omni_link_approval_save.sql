-- One authoritative OMNI link approval (ID + expiry) saved by the owner after a fresh passkey.
-- When this row exists it overrides the legacy OMNI_LINK_APPROVAL_* project settings; it never
-- enables the link and is not OMNI project access. Only the server (service role) can read it,
-- and only save_omni_link_approval can write it, atomically with consuming the passkey grant.
CREATE TABLE public.omni_link_approval (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  approval_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  saved_by uuid NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.omni_link_approval FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.omni_link_approval TO service_role;
ALTER TABLE public.omni_link_approval ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.save_omni_link_approval(_actor uuid, _grant uuid, _approval uuid, _expires timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  g public.step_up_grants;
  replaced boolean;
BEGIN
  IF _actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _actor AND role = 'owner') THEN
    RAISE EXCEPTION 'Owner required';
  END IF;
  SELECT * INTO g FROM public.step_up_grants
    WHERE id = _grant AND user_id = _actor AND action = 'omni_link_approval_save'
      AND target = 'omni-link-approval' AND used_at IS NULL AND expires_at > now()
    FOR UPDATE;
  IF NOT FOUND OR g.credential_id IS NULL OR g.credential_id = '' OR g.credential_id LIKE 'recent:%' THEN
    RAISE EXCEPTION 'Fresh passkey confirmation required';
  END IF;
  IF _approval IS NULL OR _expires IS NULL THEN
    RAISE EXCEPTION 'Approval ID and expiry are both required';
  END IF;
  IF _expires <= now() THEN
    RAISE EXCEPTION 'Approval expiry must be in the future';
  END IF;
  IF _expires > now() + interval '24 hours' THEN
    RAISE EXCEPTION 'Approval expiry must be within 24 hours';
  END IF;

  UPDATE public.step_up_grants SET used_at = now() WHERE id = _grant;
  replaced := EXISTS (SELECT 1 FROM public.omni_link_approval WHERE id = 1);
  INSERT INTO public.omni_link_approval(id, approval_id, expires_at, saved_by, saved_at)
    VALUES (1, _approval, _expires, _actor, now())
    ON CONFLICT (id) DO UPDATE
      SET approval_id = EXCLUDED.approval_id, expires_at = EXCLUDED.expires_at,
          saved_by = EXCLUDED.saved_by, saved_at = EXCLUDED.saved_at;
  INSERT INTO public.site_log(actor, action, category, status, summary, detail)
    VALUES (_actor::text, 'omni_link.approval_saved', 'config', 'ok',
      'Owner saved a new OMNI link approval with a fresh passkey (values not logged). Railway must be updated by hand.',
      jsonb_build_object('replacedPrevious', replaced,
        'validForHours', round(extract(epoch FROM (_expires - now())) / 3600.0, 1)));
  RETURN jsonb_build_object('saved', true, 'replacedPrevious', replaced,
    'validForHours', round(extract(epoch FROM (_expires - now())) / 3600.0, 1));
END $$;
REVOKE ALL ON FUNCTION public.save_omni_link_approval(uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_omni_link_approval(uuid, uuid, uuid, timestamptz) TO service_role;

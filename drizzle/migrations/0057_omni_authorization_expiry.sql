-- Expire stale OMNI access on owner diagnostics reads and revoke every dependent job grant.
-- Replacements continue through the existing fresh-passkey authorization path.
CREATE OR REPLACE FUNCTION public.expire_omni_project_authorizations(_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  expired_authorization record;
  expired_authorizations int := 0;
  expired_job_approvals int := 0;
  affected int := 0;
BEGIN
  IF _actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _actor AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Owner required';
  END IF;

  FOR expired_authorization IN
    UPDATE public.omni_project_authorizations
      SET revoked_at = now(), revoked_reason = 'expired'
      WHERE revoked_at IS NULL AND expires_at <= now()
      RETURNING id, project_id, expires_at
  LOOP
    UPDATE public.omni_dispatch_grants
      SET revoked_at = now()
      WHERE authorization_id = expired_authorization.id AND revoked_at IS NULL;
    GET DIAGNOSTICS affected = ROW_COUNT;
    expired_job_approvals := expired_job_approvals + affected;
    expired_authorizations := expired_authorizations + 1;
    INSERT INTO public.site_log(actor, action, category, status, summary, project_id, detail)
      VALUES(_actor::text, 'omni.project.expire', 'approval', 'blocked',
        'Expired OMNI project access automatically revoked', expired_authorization.project_id,
        jsonb_build_object(
          'authorizationId', expired_authorization.id,
          'expiresAt', expired_authorization.expires_at,
          'revokedJobApprovals', affected
        ));
  END LOOP;

  UPDATE public.omni_dispatch_grants
    SET revoked_at = now()
    WHERE revoked_at IS NULL AND expires_at <= now();
  GET DIAGNOSTICS affected = ROW_COUNT;
  expired_job_approvals := expired_job_approvals + affected;
  IF affected > 0 THEN
    INSERT INTO public.site_log(actor, action, category, status, summary, detail)
      VALUES(_actor::text, 'omni.dispatch.expire', 'approval', 'blocked',
        'Expired OMNI job approvals automatically revoked',
        jsonb_build_object('revokedJobApprovals', affected));
  END IF;

  RETURN jsonb_build_object(
    'expiredAuthorizations', expired_authorizations,
    'expiredJobApprovals', expired_job_approvals
  );
END $$;
REVOKE ALL ON FUNCTION public.expire_omni_project_authorizations(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_omni_project_authorizations(uuid) TO service_role;

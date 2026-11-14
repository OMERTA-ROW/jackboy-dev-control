-- ROLLBACK (prepared, NOT applied). Removes the durable owner-scope change and returns to the 0070 state.
-- Run only with separate owner approval, inside one transaction. Saved authorizations stay; only the
-- job-kind column, history guard and owner-scope permit wrapper are removed.
DROP FUNCTION public.omni_execution_permit_action(text,jsonb);
ALTER FUNCTION public.omni_execution_permit_action_without_owner_scope(text,jsonb) RENAME TO omni_execution_permit_action;
REVOKE ALL ON FUNCTION public.omni_execution_permit_action(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_execution_permit_action(text,jsonb) TO service_role;
DROP FUNCTION public.omni_autonomy_authorize_scoped(uuid,text,uuid,uuid,boolean,text[]);
DROP TRIGGER omni_autonomy_authorization_guard ON public.omni_autonomy_authorizations;
DROP TRIGGER omni_autonomy_authorization_no_truncate ON public.omni_autonomy_authorizations;
DROP FUNCTION public.omni_autonomy_authorization_guard();
ALTER TABLE public.omni_autonomy_authorizations DROP CONSTRAINT omni_autonomy_capabilities_allowed;
ALTER TABLE public.omni_autonomy_authorizations DROP COLUMN capabilities;

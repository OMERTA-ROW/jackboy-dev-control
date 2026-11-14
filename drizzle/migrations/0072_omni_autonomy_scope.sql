-- DRAFT (not journaled, not installed). Durable owner authorization scope for OMNI autonomous work.
-- Requires 0066-0070 to be installed first (it wraps the 0070 permit authority). Reuses the installed
-- omni_autonomy_authorizations table, passkey check and audit list; it adds no second authorization.
--  * capabilities: which job kinds the owner allowed ('autonomous', 'code'); default both, matching 0066.
--  * history: rows are never deleted; scope is immutable; revocation is final; capabilities may only be
--    narrowed inside the transaction that created the row (the passkey-confirmed authorization).
--  * every permit request/renewal additionally requires the session owner to be the authorizing owner
--    and the job kind to be one the owner allowed. Kill Switch, Emergency Stop, CODE setting, session,
--    nonce, expiry and spending checks stay in the installed authority underneath and run on every call.
-- It never writes a switch, releases a stop, enables CODE, starts a job or stores a token or passkey.

ALTER TABLE public.omni_autonomy_authorizations
  ADD COLUMN capabilities text[] NOT NULL DEFAULT ARRAY['autonomous','code']::text[];
ALTER TABLE public.omni_autonomy_authorizations
  ADD CONSTRAINT omni_autonomy_capabilities_allowed CHECK (
    cardinality(capabilities) BETWEEN 1 AND 2
    AND capabilities <@ ARRAY['autonomous','code']::text[]
    AND array_position(capabilities, NULL) IS NULL);
COMMENT ON COLUMN public.omni_autonomy_authorizations.capabilities IS
  'Job kinds the owner allowed with a passkey; checked on every OMNI permit request and renewal.';

CREATE FUNCTION public.omni_autonomy_authorization_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'OMNI authorization history is kept; revoke instead of deleting';
  END IF;
  IF ROW(NEW.id, NEW.owner_id, NEW.client_id, NEW.project_id, NEW.approval_id, NEW.step8_job_id,
         NEW.daily_limit_usd, NEW.per_call_limit_usd, NEW.per_task_reserve_usd, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.owner_id, OLD.client_id, OLD.project_id, OLD.approval_id, OLD.step8_job_id,
         OLD.daily_limit_usd, OLD.per_call_limit_usd, OLD.per_task_reserve_usd, OLD.created_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'OMNI authorization scope is immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND ROW(NEW.revoked_at, NEW.revoked_reason) IS DISTINCT FROM ROW(OLD.revoked_at, OLD.revoked_reason) THEN
    RAISE EXCEPTION 'OMNI authorization revocation is final';
  END IF;
  IF NEW.capabilities IS DISTINCT FROM OLD.capabilities AND (
       OLD.revoked_at IS NOT NULL OR OLD.created_at IS DISTINCT FROM now()
       OR NOT (NEW.capabilities <@ OLD.capabilities)) THEN
    RAISE EXCEPTION 'OMNI capabilities can only be narrowed while the authorization is being created';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.omni_autonomy_authorization_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER omni_autonomy_authorization_guard BEFORE UPDATE OR DELETE ON public.omni_autonomy_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.omni_autonomy_authorization_guard();
CREATE TRIGGER omni_autonomy_authorization_no_truncate BEFORE TRUNCATE ON public.omni_autonomy_authorizations
  FOR EACH STATEMENT EXECUTE FUNCTION public.omni_autonomy_authorization_guard();

-- Owner decision with an explicit capability scope. All checks and the single-use passkey stay in the
-- installed omni_autonomy_authorization_action; this only fixes the scope on the row it creates.
CREATE FUNCTION public.omni_autonomy_authorize_scoped(
  _actor uuid, _client text, _project uuid, _step uuid, _runner_ready boolean, _capabilities text[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  caps text[];
  appr uuid;
  existing public.omni_autonomy_authorizations;
  r jsonb;
  row_caps text[];
BEGIN
  IF _actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _actor AND role = 'owner') THEN
    RAISE EXCEPTION 'Only the owner can change OMNI autonomous permission';
  END IF;
  IF _client IS NULL OR _client !~ '^[a-zA-Z0-9_-]{1,64}$' OR _project IS NULL THEN
    RAISE EXCEPTION 'OMNI client and project are required';
  END IF;
  IF _capabilities IS NULL OR array_position(_capabilities, NULL) IS NOT NULL
     OR NOT (_capabilities <@ ARRAY['autonomous','code']::text[]) THEN
    RAISE EXCEPTION 'Allowed OMNI capabilities are autonomous and code';
  END IF;
  SELECT array_agg(DISTINCT c ORDER BY c) INTO caps FROM unnest(_capabilities) AS c;
  IF caps IS NULL OR cardinality(caps) = 0 THEN
    RAISE EXCEPTION 'Choose at least one allowed OMNI capability';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('omni-permit:' || _client, 0));

  SELECT approval_id INTO appr FROM public.omni_link_approval WHERE id = 1;
  SELECT * INTO existing FROM public.omni_autonomy_authorizations
    WHERE client_id = _client AND revoked_at IS NULL AND expires_at > now();
  IF existing.id IS NOT NULL AND existing.project_id = _project AND existing.approval_id IS NOT DISTINCT FROM appr
     AND existing.capabilities IS DISTINCT FROM caps THEN
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (_actor, 'omni.autonomy_authorize_refused', jsonb_build_object('client', _client,
        'reasons', jsonb_build_array('capabilities_change_requires_revoke'),
        'current', to_jsonb(existing.capabilities), 'requested', to_jsonb(caps)), 'refused');
    RETURN jsonb_build_object('ok', false, 'reasons', jsonb_build_array('capabilities_change_requires_revoke'),
      'capabilities', to_jsonb(existing.capabilities));
  END IF;

  r := public.omni_autonomy_authorization_action('authorize', _actor, _client, _project, _step, _runner_ready, NULL);
  IF (r->>'ok')::boolean IS TRUE AND (r->>'duplicate')::boolean IS NOT TRUE THEN
    UPDATE public.omni_autonomy_authorizations SET capabilities = caps WHERE id = (r->>'id')::uuid;
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (_actor, 'omni.autonomy_scope', jsonb_build_object('authorization', (r->>'id')::uuid,
        'client', _client, 'project', _project, 'approval', appr, 'capabilities', to_jsonb(caps)), 'ok');
  END IF;
  IF (r->>'ok')::boolean IS TRUE THEN
    SELECT capabilities INTO row_caps FROM public.omni_autonomy_authorizations WHERE id = (r->>'id')::uuid;
    r := r || jsonb_build_object('capabilities', to_jsonb(row_caps));
  END IF;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION public.omni_autonomy_authorize_scoped(uuid,text,uuid,uuid,boolean,text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_autonomy_authorize_scoped(uuid,text,uuid,uuid,boolean,text[]) TO service_role;

-- Permit authority: owner binding and capability scope on top of the installed 0070 authority.
ALTER FUNCTION public.omni_execution_permit_action(text,jsonb)
  RENAME TO omni_execution_permit_action_without_owner_scope;
REVOKE ALL ON FUNCTION public.omni_execution_permit_action_without_owner_scope(text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.omni_execution_permit_action(_op text, _a jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  auth public.omni_autonomy_authorizations;
  permit public.omni_execution_permits;
  reason text;
  result jsonb;
BEGIN
  -- Same lock order as 0067/0070: global policy, CODE controls, then the per-client permit lock.
  PERFORM 1 FROM public.automation_policy WHERE id = 1 FOR SHARE;
  PERFORM 1 FROM public.code_runtime_controls WHERE singleton FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('omni-permit:' || (_a->>'clientId'), 0));
  IF _op IN ('request', 'safety') THEN
    SELECT * INTO auth FROM public.omni_autonomy_authorizations
      WHERE client_id = _a->>'clientId' AND project_id = (_a->>'projectId')::uuid
        AND approval_id = (_a->>'approvalId')::uuid AND revoked_at IS NULL AND expires_at > now();
    IF auth.id IS NOT NULL AND auth.owner_id IS DISTINCT FROM (_a->>'ownerId')::uuid THEN
      reason := 'owner_scope';
    ELSIF _op = 'request' AND auth.id IS NOT NULL AND _a->>'kind' IN ('autonomous', 'code')
      AND NOT (_a->>'kind' = ANY (auth.capabilities)) THEN
      reason := 'capability_not_authorized';
    END IF;
  END IF;

  -- On refusal the installed authority still validates the session and consumes the nonce.
  result := public.omni_execution_permit_action_without_owner_scope(
    CASE WHEN _op = 'request' AND reason IS NOT NULL THEN 'safety' ELSE _op END, _a);
  IF result->>'http' = '200' AND _op = 'request' AND reason IS NOT NULL THEN
    IF result->'safety'->>'blockedBy' IN (
      'kill_switch_on','emergency_stop_engaged','code_disabled','approval_expired','owner_scope','not_authorized',
      'meter_untrusted','gateway_unenforced')
    THEN reason := result->'safety'->>'blockedBy'; END IF;
    SELECT * INTO permit FROM public.omni_execution_permits
      WHERE client_id = _a->>'clientId' AND job_id = NULLIF(_a->>'jobId', '')::uuid FOR UPDATE;
    IF permit.id IS NOT NULL AND permit.status = 'active' THEN
      UPDATE public.omni_execution_permits SET status = 'revoked', closed_at = now(), closed_reason = reason
        WHERE id = permit.id RETURNING * INTO permit;
    END IF;
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (NULL, 'omni.permit_refused', jsonb_build_object('job', _a->>'jobId', 'kind', _a->>'kind',
        'reason', reason, 'permit', permit.id), 'refused');
    RETURN jsonb_build_object('http', 403, 'error', 'permit_denied', 'reason', reason,
      'permit', CASE WHEN permit.id IS NULL THEN NULL ELSE
        jsonb_build_object('id', permit.id, 'jobId', permit.job_id, 'status', permit.status) END);
  END IF;
  IF _op = 'safety' AND result->>'http' = '200' THEN
    IF reason IS NOT NULL AND result->'safety'->>'autonomousAllowed' = 'true' THEN
      result := jsonb_set(result, '{safety,autonomousAllowed}', 'false'::jsonb);
      result := jsonb_set(result, '{safety,blockedBy}', to_jsonb(reason));
    END IF;
    IF auth.id IS NOT NULL AND reason IS NULL AND jsonb_typeof(result->'safety'->'authorization') = 'object' THEN
      result := jsonb_set(result, '{safety,authorization,capabilities}', to_jsonb(auth.capabilities));
    END IF;
  END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.omni_execution_permit_action(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_execution_permit_action(text,jsonb) TO service_role;
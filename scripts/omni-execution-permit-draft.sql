-- DRAFT (not journaled, not installed): Jackboy is the final permission and Emergency Stop gate for
-- OMNI autonomous/CODE execution. OMNI may run such a job only while it holds a fresh Jackboy permit
-- (<= 60 s, renewed over the signed omni.link/v2 session). Every renewal re-checks the System Kill
-- Switch, the CODE Emergency Stop, the saved CODE setting, the owner's passkey authorization, the
-- trusted meter and the spending guard. Stopping revokes every active permit in the same transaction.
-- An OMNI-side Step 10 approval is never enough on its own.

CREATE TABLE public.omni_autonomy_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  client_id text NOT NULL CHECK (client_id ~ '^[a-zA-Z0-9_-]{1,64}$'),
  project_id uuid NOT NULL REFERENCES public.owner_projects(id),
  approval_id uuid NOT NULL,
  step8_job_id uuid NOT NULL REFERENCES public.omni_inbound_jobs(id),
  daily_limit_usd numeric(10,2) NOT NULL DEFAULT 5.00 CHECK (daily_limit_usd = 5.00),
  per_call_limit_usd numeric(10,2) NOT NULL DEFAULT 0.50 CHECK (per_call_limit_usd = 0.50),
  per_task_reserve_usd numeric(10,2) NOT NULL DEFAULT 1.00 CHECK (per_task_reserve_usd = 1.00),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text CHECK (revoked_reason IS NULL OR char_length(revoked_reason) <= 300),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours')
);
CREATE UNIQUE INDEX omni_autonomy_one_active ON public.omni_autonomy_authorizations(client_id) WHERE revoked_at IS NULL;

CREATE TABLE public.omni_execution_permits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_id uuid NOT NULL REFERENCES public.omni_autonomy_authorizations(id),
  client_id text NOT NULL,
  project_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  job_id uuid NOT NULL,
  job_kind text NOT NULL CHECK (job_kind IN ('autonomous', 'code')),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
  reserved_usd numeric(10,2) NOT NULL CHECK (reserved_usd = 1.00),
  status text NOT NULL CHECK (status IN ('active', 'released', 'revoked', 'expired')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  renewed_at timestamptz NOT NULL DEFAULT now(),
  renewals integer NOT NULL DEFAULT 0 CHECK (renewals >= 0),
  expires_at timestamptz NOT NULL CHECK (expires_at <= renewed_at + interval '60 seconds'),
  closed_at timestamptz,
  closed_reason text,
  UNIQUE (client_id, job_id)
);
CREATE INDEX omni_execution_permits_active ON public.omni_execution_permits(client_id, status);
CREATE INDEX omni_execution_permits_issued ON public.omni_execution_permits(issued_at);

ALTER TABLE public.omni_autonomy_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_execution_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.omni_autonomy_authorizations, public.omni_execution_permits FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.omni_autonomy_authorizations, public.omni_execution_permits TO service_role;

-- Owner decision on Jackboy (fresh passkey). Validates Step 7 expiry, Step 8 proof, a recent Step 9
-- signed handshake, runner, trusted meter and spending guard. It never releases a stop, changes a
-- switch, starts a job or rotates a key; execution stays blocked while any stop is on.
CREATE FUNCTION public.omni_autonomy_authorization_action(
  _op text, _actor uuid, _client text, _project uuid, _step uuid, _runner_ready boolean, _reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  appr record;
  proof public.omni_inbound_jobs;
  existing public.omni_autonomy_authorizations;
  created public.omni_autonomy_authorizations;
  step public.step_up_grants;
  controls public.code_runtime_controls;
  paused boolean;
  reasons text[] := ARRAY[]::text[];
  blocked text[] := ARRAY[]::text[];
  n_auth int := 0;
  n_permits int := 0;
BEGIN
  IF _op IS NULL OR _op NOT IN ('authorize', 'revoke') THEN RAISE EXCEPTION 'Invalid authorization operation'; END IF;
  IF _actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _actor AND role = 'owner') THEN
    RAISE EXCEPTION 'Only the owner can change OMNI autonomous permission';
  END IF;
  IF _client IS NULL OR _client !~ '^[a-zA-Z0-9_-]{1,64}$' OR _project IS NULL THEN
    RAISE EXCEPTION 'OMNI client and project are required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('omni-permit:' || _client, 0));

  IF _op = 'revoke' THEN
    UPDATE public.omni_autonomy_authorizations
      SET revoked_at = now(), revoked_reason = left(COALESCE(NULLIF(trim(_reason), ''), 'revoked by owner'), 300)
      WHERE client_id = _client AND revoked_at IS NULL;
    GET DIAGNOSTICS n_auth = ROW_COUNT;
    UPDATE public.omni_execution_permits SET status = 'revoked', closed_at = now(), closed_reason = 'authorization_revoked'
      WHERE client_id = _client AND status = 'active';
    GET DIAGNOSTICS n_permits = ROW_COUNT;
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (_actor, 'omni.autonomy_revoked', jsonb_build_object('client', _client, 'authorizations', n_auth, 'permits', n_permits), 'ok');
    RETURN jsonb_build_object('ok', true, 'revokedAuthorizations', n_auth, 'revokedPermits', n_permits);
  END IF;

  SELECT approval_id, expires_at, saved_at INTO appr FROM public.omni_link_approval WHERE id = 1;
  IF appr.approval_id IS NULL OR appr.expires_at <= now() OR appr.expires_at > now() + interval '24 hours' THEN
    reasons := array_append(reasons, 'step7_approval_expired');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.owner_projects WHERE id = _project AND created_by = _actor AND active) THEN
    reasons := array_append(reasons, 'project_scope');
  END IF;
  IF appr.approval_id IS NOT NULL THEN
    SELECT * INTO proof FROM public.omni_inbound_jobs
      WHERE client_id = _client AND project_id = _project AND approval_id = appr.approval_id
        AND kind = 'protocol.self-test' AND status = 'completed'
        AND result->>'passed' = 'true' AND result->>'checks' = '3'
        AND result->>'runner' = 'restricted-protocol-self-test'
        AND updated_at >= appr.saved_at
      ORDER BY updated_at DESC LIMIT 1;
  END IF;
  IF proof.id IS NULL THEN reasons := array_append(reasons, 'step8_proof_missing'); END IF;
  IF appr.approval_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.omni_link_sessions
    WHERE client_id = _client AND project_id = _project AND approval_id = appr.approval_id
      AND expires_at > now() - interval '25 minutes'
  ) THEN reasons := array_append(reasons, 'step9_handshake_missing'); END IF;
  IF _runner_ready IS DISTINCT FROM true THEN reasons := array_append(reasons, 'runner_unavailable'); END IF;
  IF COALESCE(public.code_spend_meter_status()->>'ok', 'false') <> 'true' THEN reasons := array_append(reasons, 'meter_untrusted'); END IF;
  IF NOT COALESCE(public.code_total_spend_guard_enforced(), false) THEN reasons := array_append(reasons, 'gateway_unenforced'); END IF;

  SELECT * INTO existing FROM public.omni_autonomy_authorizations
    WHERE client_id = _client AND revoked_at IS NULL AND expires_at > now();
  IF existing.id IS NOT NULL AND existing.approval_id = appr.approval_id AND existing.project_id = _project
     AND cardinality(reasons) = 0 THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'id', existing.id, 'expiresAt', existing.expires_at);
  END IF;

  IF cardinality(reasons) = 0 THEN
    SELECT * INTO step FROM public.step_up_grants
      WHERE id = _step AND user_id = _actor AND action = 'omni_autonomy'
        AND target = 'omni-autonomy:' || appr.approval_id::text
        AND used_at IS NULL AND expires_at > now() AND credential_id NOT LIKE 'recent:%'
      FOR UPDATE;
    IF step.id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.owner_passkeys WHERE user_id = _actor AND credential_id = step.credential_id
    ) THEN reasons := array_append(reasons, 'fresh_passkey_required'); END IF;
  END IF;

  IF cardinality(reasons) > 0 THEN
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (_actor, 'omni.autonomy_authorize_refused', jsonb_build_object('client', _client, 'reasons', to_jsonb(reasons)), 'refused');
    RETURN jsonb_build_object('ok', false, 'reasons', to_jsonb(reasons));
  END IF;

  UPDATE public.omni_autonomy_authorizations SET revoked_at = now(), revoked_reason = 'replaced by a new owner authorization'
    WHERE client_id = _client AND revoked_at IS NULL;
  UPDATE public.omni_execution_permits SET status = 'revoked', closed_at = now(), closed_reason = 'authorization_replaced'
    WHERE client_id = _client AND status = 'active';
  UPDATE public.step_up_grants SET used_at = now() WHERE id = step.id;
  INSERT INTO public.omni_autonomy_authorizations(owner_id, client_id, project_id, approval_id, step8_job_id, expires_at)
    VALUES (_actor, _client, _project, appr.approval_id, proof.id, appr.expires_at)
    RETURNING * INTO created;

  SELECT ap.paused INTO paused FROM public.automation_policy AS ap WHERE ap.id = 1;
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true;
  IF COALESCE(paused, true) THEN blocked := array_append(blocked, 'kill_switch_on'); END IF;
  IF controls.singleton IS DISTINCT FROM true OR controls.kill_switch THEN blocked := array_append(blocked, 'emergency_stop_engaged'); END IF;
  IF controls.singleton IS DISTINCT FROM true OR NOT controls.enabled THEN blocked := array_append(blocked, 'code_disabled'); END IF;

  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (_actor, 'omni.autonomy_authorized', jsonb_build_object('authorization', created.id, 'client', _client,
      'project', _project, 'approval', created.approval_id, 'step8_job', proof.id, 'expires_at', created.expires_at,
      'daily_limit_usd', created.daily_limit_usd, 'per_call_limit_usd', created.per_call_limit_usd,
      'per_task_reserve_usd', created.per_task_reserve_usd, 'execution_blocked_by', to_jsonb(blocked)), 'ok');
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'id', created.id, 'expiresAt', created.expires_at,
    'executionBlockedBy', to_jsonb(blocked));
END $$;

-- Called only by the signed link handler (service role) after HMAC verification.
-- ops: 'request' (issue or renew one job's permit), 'release' (job finished), 'safety' (signed state).
CREATE FUNCTION public.omni_execution_permit_action(_op text, _a jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  client text := _a->>'clientId';
  project uuid := (_a->>'projectId')::uuid;
  approval uuid := (_a->>'approvalId')::uuid;
  owner_id uuid := (_a->>'ownerId')::uuid;
  expiry timestamptz := (_a->>'approvalExpiresAt')::timestamptz;
  job uuid := NULLIF(_a->>'jobId', '')::uuid;
  kind text := _a->>'kind';
  dig text := _a->>'digest';
  estimate numeric := NULLIF(_a->>'estimateUsd', '')::numeric;
  auth public.omni_autonomy_authorizations;
  p public.omni_execution_permits;
  controls public.code_runtime_controls;
  paused boolean;
  reason text;
  spent numeric;
  day_start timestamptz := date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  IF _op IS NULL OR _op NOT IN ('request', 'release', 'safety') THEN RAISE EXCEPTION 'invalid operation'; END IF;
  IF client IS NULL OR client !~ '^[a-zA-Z0-9_-]{1,64}$' THEN RAISE EXCEPTION 'invalid client'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('omni-permit:' || client, 0));

  IF NOT EXISTS (SELECT 1 FROM public.omni_link_sessions WHERE token_hash = _a->>'tokenHash'
      AND client_id = client AND project_id = project AND approval_id = approval AND expires_at > now()) THEN
    RETURN jsonb_build_object('http', 401, 'error', 'session_expired_or_invalid');
  END IF;
  INSERT INTO public.omni_callback_nonces(nonce) VALUES ('permit-v1:' || client || ':' || (_a->>'nonce')) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN jsonb_build_object('http', 409, 'error', 'replay'); END IF;

  -- Lapsed permits never come back: a job whose permit expired must stop and start again.
  UPDATE public.omni_execution_permits SET status = 'expired', closed_at = now(), closed_reason = 'not_renewed_in_time'
    WHERE client_id = client AND status = 'active' AND expires_at <= now();

  SELECT ap.paused INTO paused FROM public.automation_policy AS ap WHERE ap.id = 1;
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true;
  SELECT * INTO auth FROM public.omni_autonomy_authorizations
    WHERE client_id = client AND project_id = project AND approval_id = approval
      AND revoked_at IS NULL AND expires_at > now();

  reason := CASE
    WHEN expiry IS NULL OR expiry <= now() OR expiry > now() + interval '24 hours' THEN 'approval_expired'
    WHEN NOT EXISTS (SELECT 1 FROM public.owner_projects WHERE id = project AND created_by = owner_id AND active)
      OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = owner_id AND role = 'owner') THEN 'owner_scope'
    WHEN COALESCE(paused, true) THEN 'kill_switch_on'
    WHEN controls.singleton IS DISTINCT FROM true OR controls.kill_switch THEN 'emergency_stop_engaged'
    WHEN NOT controls.enabled THEN 'code_disabled'
    WHEN auth.id IS NULL THEN 'not_authorized'
    ELSE NULL END;

  IF _op = 'safety' THEN
    RETURN jsonb_build_object('http', 200, 'safety', jsonb_build_object(
      'checkedAt', now(), 'validUntil', now() + interval '30 seconds',
      'killSwitch', COALESCE(paused, true),
      'emergencyStop', controls.singleton IS DISTINCT FROM true OR controls.kill_switch,
      'codeEnabled', controls.singleton IS NOT DISTINCT FROM true AND controls.enabled,
      'authorization', CASE WHEN auth.id IS NULL THEN NULL ELSE jsonb_build_object('id', auth.id, 'expiresAt', auth.expires_at) END,
      'autonomousAllowed', reason IS NULL,
      'blockedBy', reason,
      'manualDiagnosticsAllowed', NOT COALESCE(paused, true),
      'activePermits', (SELECT count(*) FROM public.omni_execution_permits WHERE client_id = client AND status = 'active')));
  END IF;

  IF job IS NULL THEN RETURN jsonb_build_object('http', 400, 'error', 'job_required'); END IF;
  SELECT * INTO p FROM public.omni_execution_permits WHERE client_id = client AND job_id = job FOR UPDATE;

  IF _op = 'release' THEN
    IF p.id IS NULL THEN RETURN jsonb_build_object('http', 404, 'error', 'permit_not_found'); END IF;
    IF p.status = 'active' THEN
      UPDATE public.omni_execution_permits SET status = 'released', closed_at = now(), closed_reason = 'released_by_omni'
        WHERE id = p.id RETURNING * INTO p;
      INSERT INTO public.audit_logs(actor, action, detail, outcome)
        VALUES (NULL, 'omni.permit_released', jsonb_build_object('permit', p.id, 'job', job), 'ok');
    END IF;
    RETURN jsonb_build_object('http', 200, 'permit', jsonb_build_object('id', p.id, 'jobId', p.job_id, 'status', p.status));
  END IF;

  -- request
  IF reason IS NULL AND (kind IS NULL OR kind NOT IN ('autonomous', 'code') OR dig IS NULL OR dig !~ '^[a-f0-9]{64}$'
      OR estimate IS NULL OR estimate <= 0 OR estimate > auth.per_task_reserve_usd) THEN reason := 'scope_invalid'; END IF;
  IF reason IS NULL AND p.id IS NOT NULL THEN
    IF p.status = 'expired' THEN reason := 'permit_lapsed';
    ELSIF p.status <> 'active' THEN reason := 'job_closed';
    ELSIF p.job_kind <> kind OR p.payload_digest <> dig OR p.authorization_id <> auth.id THEN reason := 'scope_mismatch';
    END IF;
  END IF;
  IF reason IS NULL AND p.id IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.omni_execution_permits WHERE client_id = client AND status = 'active') THEN
      reason := 'concurrency_limit';
    ELSE
      SELECT COALESCE(sum(reserved_usd), 0) INTO spent FROM public.omni_execution_permits
        WHERE client_id = client AND issued_at >= day_start;
      IF spent + auth.per_task_reserve_usd > auth.daily_limit_usd THEN reason := 'daily_limit'; END IF;
    END IF;
  END IF;

  IF reason IS NOT NULL THEN
    IF p.id IS NOT NULL AND p.status = 'active' THEN
      UPDATE public.omni_execution_permits SET status = 'revoked', closed_at = now(), closed_reason = reason
        WHERE id = p.id RETURNING * INTO p;
    END IF;
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (NULL, 'omni.permit_refused', jsonb_build_object('job', job, 'reason', reason, 'permit', p.id), 'refused');
    RETURN jsonb_build_object('http', 403, 'error', 'permit_denied', 'reason', reason,
      'permit', CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id', p.id, 'jobId', p.job_id, 'status', p.status) END);
  END IF;

  IF p.id IS NULL THEN
    INSERT INTO public.omni_execution_permits(authorization_id, client_id, project_id, approval_id, job_id, job_kind,
        payload_digest, reserved_usd, status, expires_at)
      VALUES (auth.id, client, project, approval, job, kind, dig, auth.per_task_reserve_usd, 'active',
        least(now() + interval '60 seconds', auth.expires_at, expiry))
      RETURNING * INTO p;
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (NULL, 'omni.permit_issued', jsonb_build_object('permit', p.id, 'job', job, 'kind', kind,
        'reserved_usd', p.reserved_usd, 'expires_at', p.expires_at), 'ok');
  ELSE
    UPDATE public.omni_execution_permits SET renewed_at = now(), renewals = renewals + 1,
        expires_at = least(now() + interval '60 seconds', auth.expires_at, expiry)
      WHERE id = p.id RETURNING * INTO p;
  END IF;
  RETURN jsonb_build_object('http', 200, 'permit', jsonb_build_object(
    'id', p.id, 'jobId', p.job_id, 'kind', p.job_kind, 'digest', p.payload_digest, 'status', p.status,
    'issuedAt', p.issued_at, 'expiresAt', p.expires_at, 'renewals', p.renewals,
    'limits', jsonb_build_object('perCallUsd', auth.per_call_limit_usd, 'perTaskUsd', auth.per_task_reserve_usd,
      'dailyUsd', auth.daily_limit_usd)));
END $$;

-- Stopping is a hard override: revoke every active permit in the stop's own transaction. A failure
-- here must never block the stop itself; renewals re-check the stop state regardless.
CREATE FUNCTION public.omni_permits_revoke_on_stop() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  why text;
  n int := 0;
BEGIN
  IF TG_TABLE_NAME = 'automation_policy' THEN
    IF NEW.paused IS TRUE AND OLD.paused IS DISTINCT FROM true THEN why := 'kill_switch_on'; END IF;
  ELSIF NEW.kill_switch IS TRUE AND OLD.kill_switch IS DISTINCT FROM true THEN why := 'emergency_stop_engaged';
  ELSIF NEW.enabled IS FALSE AND OLD.enabled IS TRUE THEN why := 'code_disabled';
  END IF;
  IF why IS NULL THEN RETURN NEW; END IF;
  BEGIN
    UPDATE public.omni_execution_permits SET status = 'revoked', closed_at = now(), closed_reason = why
      WHERE status = 'active';
    GET DIAGNOSTICS n = ROW_COUNT;
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (NULL, 'omni.permits_revoked', jsonb_build_object('reason', why, 'count', n), 'ok');
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END $$;
CREATE TRIGGER omni_permits_revoke_on_emergency_stop AFTER UPDATE OF kill_switch, enabled ON public.code_runtime_controls
  FOR EACH ROW EXECUTE FUNCTION public.omni_permits_revoke_on_stop();
CREATE TRIGGER omni_permits_revoke_on_kill_switch AFTER UPDATE OF paused ON public.automation_policy
  FOR EACH ROW EXECUTE FUNCTION public.omni_permits_revoke_on_stop();

REVOKE ALL ON FUNCTION public.omni_autonomy_authorization_action(text, uuid, text, uuid, uuid, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.omni_execution_permit_action(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.omni_permits_revoke_on_stop() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_autonomy_authorization_action(text, uuid, text, uuid, uuid, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.omni_execution_permit_action(text, jsonb) TO service_role;

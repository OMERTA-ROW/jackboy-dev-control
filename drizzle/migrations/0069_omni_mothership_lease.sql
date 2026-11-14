-- Follows the published permit/Stop authority and the unapplied bounded worker integration.
ALTER TABLE public.omni_execution_jobs ADD COLUMN mothership_lease_expires_at timestamptz;
ALTER TABLE public.omni_execution_jobs ADD COLUMN last_permission_at timestamptz;

ALTER FUNCTION public.omni_execution_control(uuid,uuid,uuid,text,jsonb)
  RENAME TO omni_execution_control_without_lease;
REVOKE ALL ON FUNCTION public.omni_execution_control_without_lease(uuid,uuid,uuid,text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.omni_execution_control(
  _owner uuid,_project uuid,_approval uuid,_op text,_a jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  snapshot jsonb;
  job public.omni_execution_jobs%ROWTYPE;
  owner_authorization uuid;
  permit_live boolean;
BEGIN
  -- Match published 0067: global policy precedes CODE controls and job locks.
  PERFORM 1 FROM public.automation_policy WHERE id=1 FOR SHARE;
  PERFORM 1 FROM public.code_runtime_controls WHERE singleton FOR UPDATE;
  SELECT id INTO owner_authorization FROM public.omni_autonomy_authorizations
    WHERE client_id=_a->>'clientId' AND owner_id=_owner AND project_id=_project
      AND approval_id=_approval AND revoked_at IS NULL AND expires_at>clock_timestamp();
  IF _op IN ('configure','arm','authorize','lease') AND owner_authorization IS NULL
  THEN RAISE EXCEPTION 'Fresh Jackboy owner authorization required'; END IF;
  IF _op IN ('lease','claim','permission') THEN
    SELECT * INTO job FROM public.omni_execution_jobs WHERE id=(_a->>'jobId')::uuid FOR UPDATE;
    permit_live := owner_authorization IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.omni_execution_permits WHERE id=job.permit_id
        AND authorization_id=owner_authorization AND client_id=_a->>'clientId'
        AND project_id=_project AND approval_id=_approval AND job_id=job.id
        AND job_kind='autonomous' AND payload_digest=job.plan_sha256
        AND status='active' AND expires_at>clock_timestamp()
    );
  END IF;
  IF _op='lease' THEN
    snapshot := public.omni_execution_control_without_lease(_owner,_project,_approval,'safety','{}');
    IF (snapshot->>'executionReady')::boolean IS DISTINCT FROM true OR NOT EXISTS (
      SELECT 1 FROM public.omni_execution_connections WHERE project_id=_project
        AND owner_id=_owner AND approval_id=_approval AND expires_at>clock_timestamp()
    ) THEN RAISE EXCEPTION 'Mothership lease is not authorized'; END IF;
    SELECT * INTO job FROM public.omni_execution_jobs WHERE id=(_a->>'jobId')::uuid FOR UPDATE;
    IF job.id IS NULL OR job.project_id IS DISTINCT FROM _project OR job.owner_id IS DISTINCT FROM _owner
      OR job.plan_sha256 IS DISTINCT FROM _a->>'planSha256'
      OR job.state NOT IN ('authorized','running') OR job.expires_at<=clock_timestamp()
      OR permit_live IS DISTINCT FROM true OR job.permit_expires_at<=clock_timestamp()
      OR (job.mothership_lease_expires_at IS NOT NULL AND job.mothership_lease_expires_at<=clock_timestamp())
    THEN RAISE EXCEPTION 'Mothership lease expired or scope changed'; END IF;
    UPDATE public.omni_execution_jobs SET mothership_lease_expires_at=
      least(clock_timestamp()+interval '1 second',expires_at,permit_expires_at) WHERE id=job.id;
    INSERT INTO public.audit_logs(actor,action,detail,outcome)
      VALUES(_owner,'omni.execution.lease',jsonb_build_object('project_id',_project,'job_id',job.id),'ok');
    snapshot := snapshot || jsonb_build_object('allowed',true,'checkedAt',clock_timestamp());
  ELSE
  IF _op IN ('claim','permission') THEN
    IF job.owner_id=_owner AND job.project_id=_project AND job.plan_sha256=_a->>'planSha256'
      AND (permit_live IS DISTINCT FROM true
        OR job.mothership_lease_expires_at IS NULL OR job.mothership_lease_expires_at<=clock_timestamp())
    THEN
      UPDATE public.omni_execution_jobs SET state='cancel_requested',cancel_delivered=false
        WHERE id=job.id AND state IN ('authorized','running');
    END IF;
  END IF;
  snapshot := public.omni_execution_control_without_lease(_owner,_project,_approval,_op,_a);
  END IF;
  IF _op IN ('claim','permission') AND snapshot->>'allowed'='true' THEN
    UPDATE public.omni_execution_jobs SET last_permission_at=clock_timestamp()
      WHERE id=(_a->>'jobId')::uuid;
  END IF;
  snapshot := snapshot || jsonb_build_object(
    'running',EXISTS(SELECT 1 FROM public.omni_execution_jobs WHERE project_id=_project
      AND state='running' AND last_permission_at>clock_timestamp()-interval '1500 milliseconds'
      AND mothership_lease_expires_at>clock_timestamp() AND permit_expires_at>clock_timestamp()),
    'executionReady',coalesce((snapshot->>'executionReady')::boolean,false)
      AND NOT EXISTS(SELECT 1 FROM public.omni_execution_jobs WHERE project_id=_project AND state='running'
        AND (last_permission_at IS NULL OR last_permission_at<=clock_timestamp()-interval '1500 milliseconds'
          OR mothership_lease_expires_at<=clock_timestamp() OR permit_expires_at<=clock_timestamp())));
  IF owner_authorization IS NULL THEN
    snapshot := snapshot || jsonb_build_object('executionReady',false,'allowed',false);
  END IF;
  RETURN snapshot;
END $$;
REVOKE ALL ON FUNCTION public.omni_execution_control(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.omni_execution_control(uuid,uuid,uuid,text,jsonb) TO service_role;

-- Reuse the installed session/nonce/passkey/budget authority; job columns are only its mirror.
ALTER FUNCTION public.omni_execution_permit_action(text,jsonb)
  RENAME TO omni_execution_permit_action_without_worker;
REVOKE ALL ON FUNCTION public.omni_execution_permit_action_without_worker(text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.omni_execution_permit_action(_op text,_a jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  job public.omni_execution_jobs%ROWTYPE;
  permit public.omni_execution_permits%ROWTYPE;
  snapshot jsonb;
  result jsonb;
BEGIN
  PERFORM 1 FROM public.automation_policy WHERE id=1 FOR SHARE;
  PERFORM 1 FROM public.code_runtime_controls WHERE singleton FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('omni-permit:'||(_a->>'clientId'),0));
  SELECT * INTO job FROM public.omni_execution_jobs WHERE id=NULLIF(_a->>'jobId','')::uuid FOR UPDATE;
  IF _op='request' AND job.id IS NOT NULL THEN
    snapshot := public.omni_execution_control(
      (_a->>'ownerId')::uuid,(_a->>'projectId')::uuid,(_a->>'approvalId')::uuid,
      'safety',jsonb_build_object('clientId',_a->>'clientId'));
    IF job.project_id IS DISTINCT FROM (_a->>'projectId')::uuid
      OR job.owner_id IS DISTINCT FROM (_a->>'ownerId')::uuid
      OR job.plan_sha256 IS DISTINCT FROM _a->>'digest' OR _a->>'kind' IS DISTINCT FROM 'autonomous'
      OR job.state NOT IN ('authorized','running') OR job.expires_at<=clock_timestamp()
      OR (job.permit_id IS NOT NULL AND job.permit_expires_at<=clock_timestamp())
      OR (snapshot->>'executionReady')::boolean IS DISTINCT FROM true
    THEN RAISE EXCEPTION 'Bounded permit scope or readiness denied'; END IF;
  END IF;
  result := public.omni_execution_permit_action_without_worker(_op,_a);
  IF _op='request' AND job.id IS NOT NULL AND result->>'http'='200' THEN
    UPDATE public.omni_execution_permits
      SET expires_at=least(expires_at,job.expires_at)
      WHERE id=(result->'permit'->>'id')::uuid RETURNING * INTO permit;
    UPDATE public.omni_execution_jobs
      SET permit_id=permit.id,permit_issued_at=permit.issued_at,
        permit_expires_at=permit.expires_at,permit_renewals=permit.renewals WHERE id=job.id;
    result := jsonb_set(result,'{permit,expiresAt}',to_jsonb(permit.expires_at));
  END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.omni_execution_permit_action(text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.omni_execution_permit_action(text,jsonb) TO service_role;

CREATE FUNCTION public.omni_execution_permit_closed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'active' THEN
    UPDATE public.omni_execution_jobs SET state='cancel_requested',cancel_delivered=false
      WHERE permit_id=NEW.id AND state IN ('authorized','running');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER omni_execution_permit_closed AFTER UPDATE OF status ON public.omni_execution_permits
  FOR EACH ROW EXECUTE FUNCTION public.omni_execution_permit_closed();
REVOKE ALL ON FUNCTION public.omni_execution_permit_closed() FROM PUBLIC,anon,authenticated;

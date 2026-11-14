-- Follows the published permit/Stop authority and the unapplied bounded worker integration.
ALTER TABLE public.omni_execution_jobs ADD COLUMN mothership_lease_expires_at timestamptz;

ALTER FUNCTION public.omni_execution_control(uuid,uuid,uuid,text,jsonb)
  RENAME TO omni_execution_control_without_lease;
REVOKE ALL ON FUNCTION public.omni_execution_control_without_lease(uuid,uuid,uuid,text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.omni_execution_control(
  _owner uuid,_project uuid,_approval uuid,_op text,_a jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE snapshot jsonb; job public.omni_execution_jobs%ROWTYPE;
BEGIN
  -- Keep the original authority and the same Stop/admission lock order.
  PERFORM 1 FROM public.code_runtime_controls WHERE singleton FOR UPDATE;
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
      OR job.permit_id IS NULL OR job.permit_expires_at<=clock_timestamp()
      OR (job.mothership_lease_expires_at IS NOT NULL AND job.mothership_lease_expires_at<=clock_timestamp())
    THEN RAISE EXCEPTION 'Mothership lease expired or scope changed'; END IF;
    UPDATE public.omni_execution_jobs SET mothership_lease_expires_at=
      least(clock_timestamp()+interval '1 second',expires_at,permit_expires_at) WHERE id=job.id;
    INSERT INTO public.audit_logs(actor,action,detail,outcome)
      VALUES(_owner,'omni.execution.lease',jsonb_build_object('project_id',_project,'job_id',job.id),'ok');
    RETURN snapshot || jsonb_build_object('allowed',true,'checkedAt',clock_timestamp());
  END IF;
  IF _op IN ('claim','permission') THEN
    SELECT * INTO job FROM public.omni_execution_jobs WHERE id=(_a->>'jobId')::uuid FOR UPDATE;
    IF job.owner_id=_owner AND job.project_id=_project AND job.plan_sha256=_a->>'planSha256'
      AND (job.mothership_lease_expires_at IS NULL OR job.mothership_lease_expires_at<=clock_timestamp())
    THEN
      UPDATE public.omni_execution_jobs SET state='cancel_requested',cancel_delivered=false
        WHERE id=job.id AND state IN ('authorized','running');
    END IF;
  END IF;
  RETURN public.omni_execution_control_without_lease(_owner,_project,_approval,_op,_a);
END $$;
REVOKE ALL ON FUNCTION public.omni_execution_control(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.omni_execution_control(uuid,uuid,uuid,text,jsonb) TO service_role;

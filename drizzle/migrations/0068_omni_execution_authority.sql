-- Bounded worker admission follows upstream 0063–0067; no existing lane or stop is enabled.
CREATE TABLE public.omni_execution_connections (
  project_id uuid PRIMARY KEY REFERENCES public.owner_projects(id),
  owner_id uuid NOT NULL REFERENCES auth.users(id),
  operation_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  connected boolean NOT NULL DEFAULT false,
  configured boolean NOT NULL DEFAULT false,
  executor_release text,
  verified_at timestamptz,
  armed boolean NOT NULL DEFAULT false
);
CREATE TABLE public.omni_execution_jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES public.omni_execution_connections(project_id),
  owner_id uuid NOT NULL REFERENCES auth.users(id),
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'authorized'
    CHECK (state IN ('authorized','running','completed','failed','cancel_requested','cancelled')),
  claimed_at timestamptz,
  finished_at timestamptz,
  cancel_delivered boolean NOT NULL DEFAULT false,
  permit_id uuid,
  permit_issued_at timestamptz,
  permit_expires_at timestamptz,
  permit_renewals integer NOT NULL DEFAULT 0
);
ALTER TABLE public.omni_execution_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_execution_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.omni_execution_connections, public.omni_execution_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.omni_execution_connections, public.omni_execution_jobs TO service_role;

CREATE FUNCTION public.omni_execution_job_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF ROW(NEW.id,NEW.project_id,NEW.owner_id,NEW.plan_sha256,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.project_id,OLD.owner_id,OLD.plan_sha256,OLD.expires_at)
    OR (OLD.state IN ('completed','failed','cancelled') AND NEW IS DISTINCT FROM OLD)
    OR (NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state='authorized' AND NEW.state IN ('running','cancel_requested')) OR
      (OLD.state='running' AND NEW.state IN ('completed','failed','cancel_requested')) OR
      (OLD.state='cancel_requested' AND NEW.state='cancelled')))
  THEN RAISE EXCEPTION 'Job scope and terminal outcome are immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER omni_execution_job_guard BEFORE UPDATE ON public.omni_execution_jobs
  FOR EACH ROW EXECUTE FUNCTION public.omni_execution_job_guard();
REVOKE ALL ON FUNCTION public.omni_execution_job_guard() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.omni_execution_control(
  _owner uuid, _project uuid, _approval uuid, _op text, _a jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  c public.code_runtime_controls%ROWTYPE;
  link public.omni_execution_connections%ROWTYPE;
  job public.omni_execution_jobs%ROWTYPE;
  expiry timestamptz;
  blocked boolean;
  ok boolean := false;
  guard jsonb;
  meter jsonb;
BEGIN
  IF _owner IS NULL OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_owner AND role='owner')
    OR NOT EXISTS (SELECT 1 FROM public.owner_projects WHERE id=_project AND created_by=_owner AND active)
    OR _op IS NULL OR _op NOT IN ('connect','configure','verify','arm','disarm','unconfigure','revoke','safety','authorize','claim','permission','finish','permit','release')
  THEN RAISE EXCEPTION 'Execution authority denied'; END IF;
  -- The same row lock serializes job admission with the existing CODE Stop transaction.
  SELECT * INTO c FROM public.code_runtime_controls WHERE singleton FOR UPDATE;
  IF c.singleton IS DISTINCT FROM true THEN RAISE EXCEPTION 'Safety state unavailable'; END IF;
  SELECT * INTO link FROM public.omni_execution_connections WHERE project_id=_project FOR UPDATE;
  blocked := c.kill_switch IS DISTINCT FROM false OR
    coalesce((SELECT paused FROM public.automation_policy WHERE id=1),true);
  IF _op = 'connect' THEN
    expiry := (_a->>'expiresAt')::timestamptz;
    IF expiry IS NULL OR expiry<=now() OR expiry>now()+interval '24 hours' OR _approval IS NULL
      OR coalesce((SELECT paused FROM public.automation_policy WHERE id=1),true)
    THEN RAISE EXCEPTION 'Connection approval expired or Kill Switch engaged'; END IF;
    IF link.project_id IS NOT NULL AND link.operation_id=(_a->>'operationId')::uuid THEN
      IF link.approval_id IS DISTINCT FROM _approval OR link.expires_at IS DISTINCT FROM expiry
        OR NOT link.connected THEN RAISE EXCEPTION 'Operation identity conflict'; END IF;
    ELSE
      IF EXISTS (SELECT 1 FROM public.omni_execution_jobs WHERE project_id=_project AND state IN ('authorized','running','cancel_requested'))
      THEN RAISE EXCEPTION 'Reconcile active jobs before reconnecting'; END IF;
      INSERT INTO public.omni_execution_connections(project_id,owner_id,operation_id,approval_id,expires_at,connected)
        VALUES(_project,_owner,(_a->>'operationId')::uuid,_approval,expiry,true)
        ON CONFLICT(project_id) DO UPDATE SET owner_id=_owner,operation_id=excluded.operation_id,
          approval_id=_approval,expires_at=expiry,connected=true,configured=false,armed=false,
          verified_at=NULL,executor_release=NULL;
    END IF;
  ELSIF _op IN ('revoke','disarm','unconfigure') THEN
    UPDATE public.omni_execution_connections SET armed=false,
      connected=CASE WHEN _op='revoke' THEN false ELSE connected END,
      configured=CASE WHEN _op IN ('revoke','unconfigure') THEN false ELSE configured END WHERE project_id=_project;
    UPDATE public.omni_execution_jobs SET state='cancel_requested',cancel_delivered=false
      WHERE project_id=_project AND state IN ('authorized','running');
  ELSIF _op NOT IN ('safety','finish','permission','release') THEN
    IF link.connected IS DISTINCT FROM true OR link.approval_id IS DISTINCT FROM _approval
      OR link.owner_id IS DISTINCT FROM _owner OR link.expires_at<=now()
    THEN RAISE EXCEPTION 'Connection is not authorized'; END IF;
    IF _op='configure' THEN
      guard := public.code_total_spend_guard_status();
      meter := public.code_spend_meter_status();
      IF c.provider_hard_cap_verified IS DISTINCT FROM true
        OR coalesce((SELECT paused FROM public.automation_policy WHERE id=1),true)
        OR link.verified_at IS NULL OR link.verified_at<now()-interval '15 minutes'
        OR link.executor_release IS DISTINCT FROM _a->>'release'
        OR (guard->>'enforced')::boolean IS DISTINCT FROM true
        OR (meter->>'ok')::boolean IS DISTINCT FROM true
        OR c.daily_spend_limit_usd>5 OR (guard->>'limit_usd')::numeric>10
      THEN RAISE EXCEPTION 'CODE spend enforcement is not verified'; END IF;
      -- Configuration does not turn on CODE, arm OMNI, or release either Stop.
      UPDATE public.omni_execution_connections SET configured=true WHERE project_id=_project;
    ELSIF _op='verify' THEN
      IF coalesce(_a->>'release','') !~ '^[a-zA-Z0-9_.-]{1,80}$' OR (_a->>'passed')::boolean IS DISTINCT FROM true
      THEN RAISE EXCEPTION 'Executor verification failed'; END IF;
      UPDATE public.omni_execution_connections SET executor_release=_a->>'release',verified_at=now(),armed=false
        WHERE project_id=_project;
    ELSIF _op='arm' THEN
      IF blocked OR link.configured IS DISTINCT FROM true OR link.verified_at IS NULL OR link.executor_release IS NULL
        OR link.verified_at<now()-interval '15 minutes' OR link.executor_release IS DISTINCT FROM _a->>'release'
        OR c.enabled IS DISTINCT FROM true OR c.provider_hard_cap_verified IS DISTINCT FROM true
        OR (public.code_spend_meter_status()->>'ok')::boolean IS DISTINCT FROM true
        OR (public.code_total_spend_guard_status()->>'enforced')::boolean IS DISTINCT FROM true
      THEN RAISE EXCEPTION 'Execution is blocked; Stop is never released here'; END IF;
      UPDATE public.omni_execution_connections SET armed=true WHERE project_id=_project;
    ELSIF _op='authorize' THEN
      IF blocked OR link.armed IS DISTINCT FROM true OR link.configured IS DISTINCT FROM true OR c.enabled IS DISTINCT FROM true
        OR link.verified_at IS NULL OR link.verified_at<now()-interval '15 minutes' OR link.executor_release IS DISTINCT FROM _a->>'release'
      THEN RAISE EXCEPTION 'Autonomous execution is disabled'; END IF;
      expiry := (_a->>'expiresAt')::timestamptz;
      IF expiry IS NULL OR expiry<=now() OR expiry>least(link.expires_at,now()+interval '60 seconds')
        OR _a->>'planSha256' !~ '^[a-f0-9]{64}$'
      THEN RAISE EXCEPTION 'Plan authorization is invalid'; END IF;
      SELECT * INTO job FROM public.omni_execution_jobs WHERE id=(_a->>'jobId')::uuid FOR UPDATE;
      IF job.id IS NOT NULL THEN
        IF job.project_id IS DISTINCT FROM _project OR job.owner_id IS DISTINCT FROM _owner
          OR job.plan_sha256 IS DISTINCT FROM _a->>'planSha256' OR job.expires_at IS DISTINCT FROM expiry
        THEN RAISE EXCEPTION 'Job identity conflict'; END IF;
      ELSE
        IF EXISTS (SELECT 1 FROM public.omni_execution_jobs WHERE state IN ('authorized','running','cancel_requested'))
        THEN RAISE EXCEPTION 'Autonomous slot is occupied'; END IF;
        INSERT INTO public.omni_execution_jobs(id,project_id,owner_id,plan_sha256,expires_at)
          VALUES((_a->>'jobId')::uuid,_project,_owner,_a->>'planSha256',expiry);
      END IF;
    END IF;
  END IF;
  IF _op IN ('permit','release') THEN
    SELECT * INTO job FROM public.omni_execution_jobs WHERE id=(_a->>'jobId')::uuid FOR UPDATE;
    IF job.id IS NULL OR job.project_id IS DISTINCT FROM _project OR job.owner_id IS DISTINCT FROM _owner
      OR (_op='permit' AND job.plan_sha256 IS DISTINCT FROM _a->>'planSha256')
    THEN RAISE EXCEPTION 'Permit scope denied'; END IF;
    IF _op='release' THEN
      UPDATE public.omni_execution_jobs SET permit_expires_at=now(),
        state=CASE WHEN state IN ('authorized','running') THEN 'cancel_requested' ELSE state END
        WHERE id=job.id AND state IN ('authorized','running','cancel_requested');
    ELSE
      IF blocked OR c.enabled IS DISTINCT FROM true OR link.armed IS DISTINCT FROM true
        OR link.configured IS DISTINCT FROM true OR job.state NOT IN ('authorized','running')
        OR link.verified_at IS NULL OR link.verified_at<now()-interval '15 minutes'
        OR job.expires_at<=now() OR (job.permit_id IS NOT NULL AND coalesce(job.permit_expires_at<=now(),true))
        OR (public.code_spend_meter_status()->>'ok')::boolean IS DISTINCT FROM true
        OR (public.code_total_spend_guard_status()->>'enforced')::boolean IS DISTINCT FROM true
        OR (_a->>'estimateUsd')::numeric IS NULL OR (_a->>'estimateUsd')::numeric<=0
        OR (_a->>'estimateUsd')::numeric>0.5
      THEN RAISE EXCEPTION 'Permit admission denied'; END IF;
      UPDATE public.omni_execution_jobs SET permit_id=coalesce(permit_id,gen_random_uuid()),
        permit_issued_at=coalesce(permit_issued_at,now()),
        permit_expires_at=least(job.expires_at,link.expires_at,now()+interval '60 seconds'),
        permit_renewals=CASE WHEN permit_id IS NULL THEN 0 ELSE permit_renewals+1 END WHERE id=job.id;
    END IF;
  END IF;
  IF _op IN ('claim','permission','finish') THEN
    SELECT * INTO job FROM public.omni_execution_jobs WHERE id=(_a->>'jobId')::uuid FOR UPDATE;
    IF job.id IS NULL OR job.project_id IS DISTINCT FROM _project OR job.owner_id IS DISTINCT FROM _owner
      OR job.plan_sha256 IS DISTINCT FROM _a->>'planSha256'
    THEN RAISE EXCEPTION 'Job scope denied'; END IF;
    IF _op='finish' THEN
      IF _a->>'outcome' NOT IN ('completed','failed','cancelled') THEN RAISE EXCEPTION 'Invalid outcome'; END IF;
      UPDATE public.omni_execution_jobs SET state=CASE WHEN state='cancel_requested' THEN 'cancelled'
        ELSE _a->>'outcome' END,finished_at=now(),cancel_delivered=true
        WHERE id=job.id AND state IN ('running','cancel_requested');
    ELSE
      ok := coalesce(NOT blocked AND c.enabled IS TRUE AND link.connected IS TRUE AND link.configured IS TRUE
        AND link.armed IS TRUE AND link.approval_id=_approval AND link.expires_at>now()
        AND link.verified_at>now()-interval '15 minutes' AND job.expires_at>now()
        AND job.permit_id IS NOT NULL AND job.permit_expires_at>now()
        AND job.state=CASE WHEN _op='claim' THEN 'authorized' ELSE 'running' END
        AND (public.code_spend_meter_status()->>'ok')::boolean IS TRUE
        AND (public.code_total_spend_guard_status()->>'enforced')::boolean IS TRUE,false);
      IF ok AND _op='claim' THEN
        UPDATE public.omni_execution_jobs SET state='running',claimed_at=now() WHERE id=job.id;
      ELSIF NOT ok AND (job.state='authorized' OR (_op='permission' AND job.state='running')) THEN
        UPDATE public.omni_execution_jobs SET state='cancel_requested',cancel_delivered=false WHERE id=job.id;
      END IF;
    END IF;
  END IF;
  INSERT INTO public.audit_logs(actor,action,detail,outcome)
    VALUES(_owner,'omni.execution.'||_op,
      jsonb_build_object('project_id',_project,'job_id',_a->>'jobId'),CASE WHEN blocked THEN 'blocked' ELSE 'ok' END);
  SELECT * INTO link FROM public.omni_execution_connections WHERE project_id=_project;
  IF _op='permit' THEN
    SELECT * INTO job FROM public.omni_execution_jobs WHERE id=(_a->>'jobId')::uuid;
    RETURN jsonb_build_object('id',job.permit_id,'jobId',job.id,'digest',job.plan_sha256,
      'issuedAt',job.permit_issued_at,'expiresAt',job.permit_expires_at,'renewals',job.permit_renewals);
  END IF;
  RETURN jsonb_build_object('allowed',ok,'checkedAt',now(),'projectId',_project,
    'jobState',(SELECT state FROM public.omni_execution_jobs WHERE id=(_a->>'jobId')::uuid),
    'connected',coalesce(link.connected,false) AND link.expires_at>now(),'configured',coalesce(link.configured,false),
    'armed',coalesce(link.armed,false),'codeEnabled',c.enabled,'emergencyStop',c.kill_switch,'killSwitch',
    coalesce((SELECT paused FROM public.automation_policy WHERE id=1),true),
    'executionReady',coalesce(NOT blocked AND c.enabled AND link.connected AND link.configured AND link.armed
      AND link.expires_at>now() AND link.verified_at>now()-interval '15 minutes'
      AND (public.code_spend_meter_status()->>'ok')::boolean IS TRUE
      AND (public.code_total_spend_guard_status()->>'enforced')::boolean IS TRUE,false),
    'expiresAt',link.expires_at,'operationId',link.operation_id,'executorRelease',link.executor_release,
    'running',EXISTS(SELECT 1 FROM public.omni_execution_jobs WHERE project_id=_project AND state='running'),
    'activePermits',(SELECT count(*) FROM public.omni_execution_jobs WHERE project_id=_project
      AND state IN ('authorized','running') AND permit_id IS NOT NULL AND permit_expires_at>now()),
    'cancellationPending',EXISTS(SELECT 1 FROM public.omni_execution_jobs WHERE project_id=_project AND state='cancel_requested'));
END $$;

CREATE FUNCTION public.omni_execution_stop_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME='automation_policy' THEN
    PERFORM 1 FROM public.code_runtime_controls WHERE singleton FOR UPDATE;
  END IF;
  IF (TG_TABLE_NAME='code_runtime_controls' AND (
      (to_jsonb(NEW)->>'kill_switch')::boolean IS DISTINCT FROM false
      OR (to_jsonb(NEW)->>'enabled')::boolean IS DISTINCT FROM true))
    OR (TG_TABLE_NAME='automation_policy' AND (to_jsonb(NEW)->>'paused')::boolean IS DISTINCT FROM false)
  THEN
    UPDATE public.omni_execution_connections SET armed=false;
    UPDATE public.omni_execution_jobs SET state='cancel_requested',cancel_delivered=false
      WHERE state IN ('authorized','running');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER omni_execution_code_stop AFTER UPDATE ON public.code_runtime_controls
  FOR EACH ROW EXECUTE FUNCTION public.omni_execution_stop_trigger();
CREATE TRIGGER omni_execution_global_stop AFTER UPDATE ON public.automation_policy
  FOR EACH ROW EXECUTE FUNCTION public.omni_execution_stop_trigger();
REVOKE ALL ON FUNCTION public.omni_execution_control(uuid,uuid,uuid,text,jsonb),
  public.omni_execution_stop_trigger() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_execution_control(uuid,uuid,uuid,text,jsonb) TO service_role;

CREATE FUNCTION public.omni_execution_cancel_ack(_job uuid,_hash text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE job public.omni_execution_jobs%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.code_runtime_controls WHERE singleton FOR UPDATE;
  SELECT * INTO job FROM public.omni_execution_jobs WHERE id=_job FOR UPDATE;
  IF job.id IS NULL OR job.plan_sha256 IS DISTINCT FROM _hash
    OR job.state NOT IN ('cancel_requested','cancelled')
  THEN RAISE EXCEPTION 'Cancellation acknowledgement scope denied'; END IF;
  IF job.state='cancelled' THEN RETURN; END IF;
  UPDATE public.omni_execution_jobs SET state='cancelled',cancel_delivered=true,finished_at=now()
    WHERE id=_job;
  INSERT INTO public.audit_logs(actor,action,detail,outcome)
    VALUES(job.owner_id,'omni.execution.cancel_ack',jsonb_build_object('job_id',_job),'ok');
END $$;

CREATE FUNCTION public.claim_omni_execution_nonce(_client text,_nonce text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE prefix text := 'execution:'||_client||':';
BEGIN
  IF _client IS NULL OR _client !~ '^[A-Za-z0-9_-]{1,64}$'
    OR _nonce IS NULL OR _nonce !~ '^[a-f0-9]{32}$'
  THEN RAISE EXCEPTION 'Invalid execution nonce'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(prefix,0));
  DELETE FROM public.omni_callback_nonces WHERE nonce LIKE 'execution:%'
    AND received_at<now()-interval '60 seconds';
  IF (SELECT count(*) FROM public.omni_callback_nonces
      WHERE left(nonce,length(prefix))=prefix)>=400
  THEN RAISE EXCEPTION 'Execution request rate exceeded'; END IF;
  INSERT INTO public.omni_callback_nonces(nonce) VALUES(prefix||_nonce);
END $$;
REVOKE ALL ON FUNCTION public.omni_execution_cancel_ack(uuid,text),
  public.claim_omni_execution_nonce(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.omni_execution_cancel_ack(uuid,text),
  public.claim_omni_execution_nonce(text,text) TO service_role;

CREATE FUNCTION public.omni_execution_session(
  _owner uuid,_project uuid,_approval uuid,_client text,_token_hash text,_op text,_a jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM 1 FROM public.code_runtime_controls WHERE singleton FOR UPDATE;
  IF _op IS NULL OR _op NOT IN ('safety','permit','release') OR NOT EXISTS (
    SELECT 1 FROM public.omni_link_sessions WHERE token_hash=_token_hash AND client_id=_client
      AND project_id=_project AND approval_id=_approval AND expires_at>now()
  ) THEN RAISE EXCEPTION 'Current signed session required'; END IF;
  RETURN public.omni_execution_control(_owner,_project,_approval,_op,_a);
END $$;
REVOKE ALL ON FUNCTION public.omni_execution_session(uuid,uuid,uuid,text,text,text,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.omni_execution_session(uuid,uuid,uuid,text,text,text,jsonb) TO service_role;

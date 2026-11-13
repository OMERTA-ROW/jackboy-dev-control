-- NOT YET APPLIED. Proposed schema for the Mothership handoff endpoint, kept outside the
-- Drizzle journal so it is applied only through a separate owner-approved migration step
-- (which records its own journal entry). Until it is applied the endpoint fails closed with
-- 503 handoff_unavailable even if JACKBOY_HANDOFF_ENABLED is set.
-- Evolution Mothership → Jackboy handoff (contract jackboy.omni-handoff/v1).
-- Server-only: no client grants or policies, so only service_role (which bypasses RLS)
-- can read or write. The RPC records an owner-approved held task as a QUEUED omni_jobs
-- row (sent_at NULL); it never dispatches. Per-job passkey approval, Kill Switch,
-- project authorization and spend caps still gate any later send.
CREATE TABLE public.omni_handoff_nonces (
  nonce text PRIMARY KEY CHECK (nonce ~ '^[a-f0-9]{32}$'),
  client_id text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  received_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE public.omni_handoff_tasks (
  task_id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES public.omni_jobs(id),
  client_id text NOT NULL CHECK (client_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  project_id uuid NOT NULL REFERENCES public.agent_projects(id),
  repo text NOT NULL CHECK (repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  kind text NOT NULL CHECK (kind IN ('test', 'code')),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
REVOKE ALL ON public.omni_handoff_nonces FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
REVOKE ALL ON public.omni_handoff_tasks FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.omni_handoff_nonces TO service_role;
--> statement-breakpoint
GRANT SELECT, INSERT ON public.omni_handoff_tasks TO service_role;
--> statement-breakpoint
ALTER TABLE public.omni_handoff_nonces ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.omni_handoff_tasks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION public.omni_handoff_create(
  _task uuid, _client text, _project uuid, _repo text, _kind text, _instructions text, _digest text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  t public.omni_handoff_tasks;
  p public.agent_projects;
  existing_status text;
  owners uuid[];
  new_job uuid;
BEGIN
  IF _task IS NULL OR _project IS NULL
     OR _client IS NULL OR _client !~ '^[A-Za-z0-9_-]{1,64}$'
     OR _repo IS NULL OR _repo !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
     OR _kind IS NULL OR _kind NOT IN ('test', 'code')
     OR _digest IS NULL OR _digest !~ '^[a-f0-9]{64}$'
     OR _instructions IS NULL OR pg_catalog.char_length(_instructions) NOT BETWEEN 3 AND 4000 THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'refused', 'reason', 'invalid_request');
  END IF;
  IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(_instructions, 'UTF8')), 'hex') <> _digest THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'refused', 'reason', 'digest_mismatch');
  END IF;

  -- One writer per task id, so a retried create cannot queue two jobs.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('omni_handoff:' || _task::text, 0));
  SELECT * INTO t FROM public.omni_handoff_tasks WHERE task_id = _task;
  IF FOUND THEN
    IF t.client_id <> _client OR t.project_id <> _project OR t.repo <> _repo
       OR t.kind <> _kind OR t.digest <> _digest THEN
      RETURN pg_catalog.jsonb_build_object('outcome', 'refused', 'reason', 'task_conflict');
    END IF;
    SELECT status INTO existing_status FROM public.omni_jobs WHERE id = t.job_id;
    RETURN pg_catalog.jsonb_build_object('outcome', 'existing', 'jobId', t.job_id, 'status', existing_status);
  END IF;

  -- Kill Switch fails closed: missing row or NULL counts as paused.
  IF NOT EXISTS (SELECT 1 FROM public.automation_policy WHERE id = 1 AND paused IS FALSE) THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'refused', 'reason', 'kill_switch_on');
  END IF;

  SELECT * INTO p FROM public.agent_projects WHERE id = _project FOR SHARE;
  IF NOT FOUND OR p.enrolled IS NOT TRUE OR p.repo_url IS DISTINCT FROM ('https://github.com/' || _repo) THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'refused', 'reason', 'project_not_authorized');
  END IF;

  SELECT pg_catalog.array_agg(user_id) INTO owners FROM public.user_roles WHERE role = 'owner';
  IF owners IS NULL OR pg_catalog.cardinality(owners) <> 1 THEN
    RETURN pg_catalog.jsonb_build_object('outcome', 'refused', 'reason', 'owner_unavailable');
  END IF;

  INSERT INTO public.omni_jobs (project_id, kind, instructions, repo, status, sent_at, guardian_verdict, created_by)
  VALUES (_project, _kind, _instructions, _repo, 'queued', NULL, 'pending', owners[1])
  RETURNING id INTO new_job;
  INSERT INTO public.omni_handoff_tasks (task_id, job_id, client_id, project_id, repo, kind, digest)
  VALUES (_task, new_job, _client, _project, _repo, _kind, _digest);
  RETURN pg_catalog.jsonb_build_object('outcome', 'created', 'jobId', new_job, 'status', 'queued');
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.omni_handoff_create(uuid, text, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.omni_handoff_create(uuid, text, uuid, text, text, text, text) TO service_role;

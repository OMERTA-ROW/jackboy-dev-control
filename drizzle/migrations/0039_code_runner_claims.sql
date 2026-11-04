ALTER TABLE public.action_requests
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz,
  ADD COLUMN IF NOT EXISTS runner_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS runner_publish_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS runner_run_id bigint,
  ADD COLUMN IF NOT EXISTS runner_run_attempt integer,
  ADD COLUMN IF NOT EXISTS runner_revision text,
  ADD COLUMN IF NOT EXISTS runner_workflow_sha text;
ALTER TABLE public.omni_connection
  ADD COLUMN IF NOT EXISTS config_hash text;

CREATE UNIQUE INDEX IF NOT EXISTS action_requests_runner_run_id_unique
  ON public.action_requests ((resources->>'repo'), runner_run_id)
  WHERE runner_run_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.claim_code_runner(
  p_request_id uuid,
  p_stage text,
  p_repository text,
  p_ref text,
  p_workflow_blob_sha text,
  p_run_id bigint,
  p_run_attempt integer,
  p_revision text,
  p_owner_id uuid,
  p_session_hash text,
  p_operation text
)
RETURNS TABLE (
  request_id uuid,
  instruction text,
  owner_id uuid,
  session_hash text,
  repository text,
  approved_ref text,
  operation text,
  base_sha text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  request_row public.action_requests%ROWTYPE;
BEGIN
  IF p_stage IS NULL
    OR p_stage NOT IN ('execute', 'publish')
    OR p_run_id IS NULL
    OR p_run_id <= 0
    OR p_run_attempt IS NULL
    OR p_run_attempt <> 1
    OR p_revision IS NULL
    OR p_revision !~ '^[a-f0-9]{40}$'
    OR p_workflow_blob_sha IS NULL
    OR p_workflow_blob_sha !~ '^[a-f0-9]{40}$'
    OR p_session_hash IS NULL
    OR p_session_hash = ''
    OR p_operation IS NULL
    OR p_operation NOT IN ('dispatch', 'retry')
  THEN
    RAISE EXCEPTION 'Invalid CODE runner claim';
  END IF;

  IF p_stage = 'execute' THEN
    UPDATE public.action_requests AS ar
    SET runner_claimed_at = now(),
        runner_run_id = p_run_id,
        runner_run_attempt = p_run_attempt,
        runner_revision = p_revision,
        runner_workflow_sha = p_workflow_blob_sha
    WHERE ar.id = p_request_id
      AND ar.action = 'code_workflow'
      AND ar.status = 'allowed'
      AND ar.mode = 'once'
      AND ar.decided_at IS NOT NULL
      AND ar.decided_by = ar.requested_by
      AND ar.expires_at > now()
      AND ar.revoked_at IS NULL
      AND ar.runner_claimed_at IS NULL
      AND ar.requested_by = p_owner_id
      AND ar.resources->>'repo' = p_repository
      AND ar.resources->>'ref' = p_ref
      AND ar.resources->>'workflowSha' = p_workflow_blob_sha
      AND ar.resources->>'baseSha' = p_revision
      AND ar.resources->>'operation' = p_operation
      AND ar.resources->>'sessionHash' = p_session_hash
      AND EXISTS (
        SELECT 1 FROM public.user_roles AS ur
        WHERE ur.user_id = ar.requested_by AND ur.role = 'owner'
      )
      AND EXISTS (
        SELECT 1 FROM public.owner_projects AS op
        WHERE op.id = ar.project_id
          AND op.github_repo = p_repository
          AND op.dev_enabled = true
      )
    RETURNING ar.* INTO request_row;
  ELSE
    UPDATE public.action_requests AS ar
    SET runner_publish_claimed_at = now()
    WHERE ar.id = p_request_id
      AND ar.action = 'code_workflow'
      AND ar.status = 'allowed'
      AND ar.mode = 'once'
      AND ar.decided_at IS NOT NULL
      AND ar.decided_by = ar.requested_by
      AND ar.expires_at > now()
      AND ar.revoked_at IS NULL
      AND ar.runner_claimed_at IS NOT NULL
      AND ar.runner_run_id = p_run_id
      AND ar.runner_run_attempt = p_run_attempt
      AND ar.runner_revision = p_revision
      AND ar.runner_workflow_sha = p_workflow_blob_sha
      AND ar.runner_publish_claimed_at IS NULL
      AND ar.requested_by = p_owner_id
      AND ar.resources->>'repo' = p_repository
      AND ar.resources->>'ref' = p_ref
      AND ar.resources->>'workflowSha' = p_workflow_blob_sha
      AND ar.resources->>'baseSha' = p_revision
      AND ar.resources->>'operation' = p_operation
      AND ar.resources->>'sessionHash' = p_session_hash
      AND EXISTS (
        SELECT 1 FROM public.user_roles AS ur
        WHERE ur.user_id = ar.requested_by AND ur.role = 'owner'
      )
      AND EXISTS (
        SELECT 1 FROM public.owner_projects AS op
        WHERE op.id = ar.project_id
          AND op.github_repo = p_repository
          AND op.dev_enabled = true
      )
    RETURNING ar.* INTO request_row;
  END IF;

  IF request_row.id IS NULL THEN
    RAISE EXCEPTION 'CODE runner approval is absent, expired, revoked, mismatched, or already claimed';
  END IF;

  RETURN QUERY SELECT
    request_row.id,
    request_row.resources->>'instruction',
    request_row.requested_by,
    request_row.resources->>'sessionHash',
    request_row.resources->>'repo',
    request_row.resources->>'ref',
    request_row.resources->>'operation',
    request_row.resources->>'baseSha';
END;
$$;

REVOKE ALL ON FUNCTION public.claim_code_runner(uuid, text, text, text, text, bigint, integer, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_code_runner(uuid, text, text, text, text, bigint, integer, text, uuid, text, text) TO service_role;
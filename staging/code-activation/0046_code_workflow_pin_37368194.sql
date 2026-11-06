-- PROPOSED, NOT APPLIED. Requires explicit owner approval before it is run against any database.
--
-- One-time guarded data update (no schema change): re-pin the CODE workflow after the owner merged
-- the gpt-6-luna model line (commit 626154bb, merged into main by PR #43).
-- Evidence: GitHub contents API for .github/workflows/code.yml on main returns blob
-- 37368194f883bc1cf5175aecf4832945203b602b, and the git-blob SHA-1 of the downloaded bytes was
-- independently recomputed to the same value on Nov 6, 2026.
--
-- Fail closed: runs only if the stored pin is exactly the previous approved value, CODE is disabled,
-- the Emergency Stop is engaged and no task is active. Re-running after success is a no-op.
-- The pin update, audit record and Site Log entry commit together or not at all.
-- Run it with the database query tool (it is a data change, not a schema migration).

DO $$
DECLARE
  owner_id constant uuid := '93a2e690-a179-4d08-bd68-a3a793fced11';
  old_targets constant jsonb := '{"OMERTA-ROW/jackboy-dev-control":{"ref":"main","workflowSha":"ebc71c1923c3d6ab925ec6b9e4fa971e311f3761"}}';
  new_targets constant jsonb := '{"OMERTA-ROW/jackboy-dev-control":{"ref":"main","workflowSha":"37368194f883bc1cf5175aecf4832945203b602b"}}';
  controls public.code_runtime_controls%ROWTYPE;
  audit_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = owner_id AND role = 'owner') THEN
    RAISE EXCEPTION 'Approving owner account not found';
  END IF;
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CODE runtime controls are missing';
  END IF;
  IF controls.allowed_targets = new_targets THEN
    RAISE NOTICE 'CODE workflow pin already set to 37368194; nothing changed';
    RETURN;
  END IF;
  IF controls.allowed_targets IS DISTINCT FROM old_targets
    OR controls.enabled IS DISTINCT FROM false
    OR controls.kill_switch IS DISTINCT FROM true
    OR controls.active_request_id IS NOT NULL
    OR controls.active_run_id IS NOT NULL
  THEN
    RAISE EXCEPTION 'CODE pin update refused: stored pin or safety state is not the expected value';
  END IF;

  UPDATE public.code_runtime_controls
    SET allowed_targets = new_targets,
        updated_at = now()
    WHERE singleton = true;

  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (owner_id, 'code.workflow_pin_repair',
      jsonb_build_object(
        'approval', 'Explicit owner approval required before this script runs',
        'old_sha', 'ebc71c1923c3d6ab925ec6b9e4fa971e311f3761',
        'new_targets', new_targets,
        'source_commit', '626154bb',
        'github_blob_independently_hashed', true,
        'enabled', false,
        'kill_switch', true,
        'performed_by', 'Lovable agent on owner authorization; SQL tool has no browser authentication'),
      'ok')
    RETURNING id INTO audit_id;

  INSERT INTO public.site_log(actor, action, category, status, summary, repo, branch, detail)
    VALUES ('agent:lovable/owner-approved', 'code.workflow_pin_repair', 'config', 'ok',
      'Owner-approved CODE workflow pin moved to 37368194 (gpt-6-luna); CODE disabled and Emergency Stop retained',
      'OMERTA-ROW/jackboy-dev-control', 'main',
      jsonb_build_object('audit_id', audit_id, 'workflow_sha', '37368194f883bc1cf5175aecf4832945203b602b',
        'no_dispatch', true, 'no_publish', true));
END;
$$;

-- 0050 CODE multi-site pins (STAGED: apply only after explicit owner approval).
-- Adds one owner-only, passkey-backed way to add or remove a site on the CODE allow list,
-- blocks every other change to allowed_targets, and lets the CODE on-switch accept several pinned sites.
-- Unchanged: spend meter, $5/day, $10 total, $1 per task, hard-cap gate, Kill Switch, single active task.

-- 1. Only set_code_site_pin may change the allow list (it sets a transaction-local marker).
CREATE OR REPLACE FUNCTION public.code_runtime_controls_pin_gate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF NEW.allowed_targets IS DISTINCT FROM OLD.allowed_targets
    AND coalesce(current_setting('jackboy.code_pin', true), '') <> 'owner-pinned'
  THEN
    RAISE EXCEPTION 'The CODE allow list can only change through set_code_site_pin (owner passkey)';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS code_runtime_controls_pin_gate ON public.code_runtime_controls;
CREATE TRIGGER code_runtime_controls_pin_gate
  BEFORE UPDATE ON public.code_runtime_controls
  FOR EACH ROW EXECUTE FUNCTION public.code_runtime_controls_pin_gate();

-- 2. Add or remove one site. The app consumes a fresh, single-use passkey grant bound to this exact
--    repo (and workflow SHA when adding) and re-checks every live gate before calling this.
CREATE OR REPLACE FUNCTION public.set_code_site_pin(
  p_actor uuid, p_repository text, p_workflow_sha text, p_add boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  controls public.code_runtime_controls%ROWTYPE;
  next_targets jsonb;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only the owner can change the CODE allow list';
  END IF;
  IF p_repository IS NULL OR p_repository !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' THEN
    RAISE EXCEPTION 'Invalid repository';
  END IF;
  IF p_repository = 'OMERTA-ROW/jackboy-dev-control' THEN
    RAISE EXCEPTION 'The Jackboy anchor pin is managed by its own reviewed migration';
  END IF;
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  IF controls.singleton IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'CODE runtime controls are missing';
  END IF;
  IF controls.active_request_id IS NOT NULL OR controls.active_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'A CODE task is active; the allow list cannot change mid-task';
  END IF;

  IF p_add THEN
    IF p_workflow_sha IS NULL OR p_workflow_sha !~ '^[a-f0-9]{40}$' THEN
      RAISE EXCEPTION 'Invalid workflow SHA';
    END IF;
    next_targets := controls.allowed_targets
      || jsonb_build_object(p_repository, jsonb_build_object('ref', 'main', 'workflowSha', p_workflow_sha));
    IF (SELECT count(*) FROM jsonb_object_keys(next_targets)) > 10 THEN
      RAISE EXCEPTION 'The CODE allow list is limited to 10 sites';
    END IF;
  ELSE
    IF NOT (controls.allowed_targets ? p_repository) THEN
      RAISE EXCEPTION 'That site is not on the CODE allow list';
    END IF;
    next_targets := controls.allowed_targets - p_repository;
  END IF;

  PERFORM pg_catalog.set_config('jackboy.code_pin', 'owner-pinned', true);
  UPDATE public.code_runtime_controls
    SET allowed_targets = next_targets, updated_at = now()
    WHERE singleton = true;
  PERFORM pg_catalog.set_config('jackboy.code_pin', '', true);

  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (p_actor, CASE WHEN p_add THEN 'code.site_pinned' ELSE 'code.site_unpinned' END,
      jsonb_build_object('repository', p_repository, 'ref', 'main', 'workflow_sha', p_workflow_sha,
        'previous', controls.allowed_targets, 'allowed_targets', next_targets), 'ok');
  RETURN next_targets;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_code_site_pin(uuid, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_code_site_pin(uuid, text, text, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.code_runtime_controls_pin_gate() FROM PUBLIC, anon, authenticated;

-- 3. CODE on-switch: same gates, but several valid pinned sites are allowed.
CREATE OR REPLACE FUNCTION public.enable_code_runtime(p_actor uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  controls public.code_runtime_controls%ROWTYPE;
  guard jsonb;
  meter jsonb;
  target jsonb;
  reasons text[] := ARRAY[]::text[];
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only the owner can turn CODE on';
  END IF;
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  IF controls.singleton IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'CODE runtime controls are missing';
  END IF;
  guard := public.code_total_spend_guard_status();
  meter := public.code_spend_meter_status();
  target := controls.allowed_targets->'OMERTA-ROW/jackboy-dev-control';

  IF controls.enabled OR NOT controls.kill_switch THEN
    reasons := reasons || 'not_stopped'::text;
  END IF;
  IF controls.active_request_id IS NOT NULL OR controls.active_run_id IS NOT NULL THEN
    reasons := reasons || 'active_task'::text;
  END IF;
  IF controls.consecutive_failures >= 2 THEN
    reasons := reasons || 'failure_stop'::text;
  END IF;
  IF controls.usage_spike THEN
    reasons := reasons || 'usage_spike'::text;
  END IF;
  IF controls.cancellation_status NOT IN ('not_needed', 'confirmed', 'completed') THEN
    reasons := reasons || 'cancellation_unconfirmed'::text;
  END IF;
  IF controls.provider_hard_cap_verified IS NOT TRUE THEN
    reasons := reasons || 'hard_cap_unverified'::text;
  END IF;
  IF NOT coalesce((guard->>'enforced')::boolean, false) THEN
    reasons := reasons || 'total_guard'::text;
  ELSIF (guard->>'committed_usd')::numeric + controls.per_task_reserve_usd > (guard->>'limit_usd')::numeric THEN
    reasons := reasons || 'total_limit'::text;
  END IF;
  IF NOT coalesce((meter->>'ok')::boolean, false) THEN
    reasons := reasons || 'spend_meter'::text;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.automation_policy WHERE id = 1 AND paused = false) THEN
    reasons := reasons || 'global_pause'::text;
  END IF;
  -- Multi-site: the Jackboy anchor pin must be valid, and every other passkey-approved pin must be well formed.
  IF target IS NULL
    OR target->>'ref' IS DISTINCT FROM 'main'
    OR coalesce(target->>'workflowSha', '') !~ '^[a-f0-9]{40}$'
    OR (SELECT count(*) FROM jsonb_object_keys(controls.allowed_targets)) > 10
    OR EXISTS (
      SELECT 1 FROM jsonb_each(controls.allowed_targets) e
      WHERE e.key !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
        OR e.value->>'ref' IS DISTINCT FROM 'main'
        OR coalesce(e.value->>'workflowSha', '') !~ '^[a-f0-9]{40}$'
    )
  THEN
    reasons := reasons || 'target_allowlist'::text;
  END IF;

  IF cardinality(reasons) > 0 THEN
    INSERT INTO public.audit_logs(actor, action, detail, outcome)
      VALUES (p_actor, 'code.runtime_enable_refused',
        jsonb_build_object('reasons', to_jsonb(reasons), 'guard', guard, 'meter', meter), 'blocked');
    RETURN jsonb_build_object('ok', false, 'reasons', to_jsonb(reasons));
  END IF;

  PERFORM pg_catalog.set_config('jackboy.code_activation', 'owner-enabled', true);
  UPDATE public.code_runtime_controls
    SET enabled = true,
        kill_switch = false,
        paused_reason = NULL,
        stop_requested_at = NULL,
        cancellation_status = 'not_needed',
        updated_at = now()
    WHERE singleton = true;
  PERFORM pg_catalog.set_config('jackboy.code_activation', '', true);
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (p_actor, 'code.runtime_enabled',
      jsonb_build_object('workflow_sha', target->>'workflowSha', 'guard', guard, 'meter', meter), 'ok');
  RETURN jsonb_build_object('ok', true, 'reasons', '[]'::jsonb);
END;
$function$;

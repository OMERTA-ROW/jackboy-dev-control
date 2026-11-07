-- Rollback for 0050 CODE multi-site pins. Run only with owner approval.
-- Remove any extra sites first (Remove from CODE with passkey); this restores the single-site on-switch rule.
DROP TRIGGER IF EXISTS code_runtime_controls_pin_gate ON public.code_runtime_controls;
DROP FUNCTION IF EXISTS public.code_runtime_controls_pin_gate();
DROP FUNCTION IF EXISTS public.set_code_site_pin(uuid, text, text, boolean);

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
  IF (SELECT count(*) FROM jsonb_object_keys(controls.allowed_targets)) <> 1
    OR target IS NULL
    OR target->>'ref' IS DISTINCT FROM 'main'
    OR coalesce(target->>'workflowSha', '') !~ '^[a-f0-9]{40}$'
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

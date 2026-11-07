-- Rollback for staged 0049. Turns CODE off and engages the Emergency Stop first (always allowed),
-- then removes the meter and activation gate. Without the meter nothing stamps provider_usage_at,
-- so every task claim refuses again (fail closed).
UPDATE public.code_runtime_controls
  SET enabled = false, kill_switch = true, provider_usage_at = NULL,
      paused_reason = coalesce(paused_reason, 'CODE meter and activation gate rolled back'),
      updated_at = now()
  WHERE singleton = true;

DROP TRIGGER IF EXISTS code_runtime_controls_activation_gate ON public.code_runtime_controls;
DROP FUNCTION IF EXISTS public.enable_code_runtime(uuid);
DROP FUNCTION IF EXISTS public.code_runtime_controls_activation_gate();
DROP FUNCTION IF EXISTS public.refresh_code_spend_meter();
DROP FUNCTION IF EXISTS public.code_spend_meter_status();
ALTER TABLE public.code_runtime_controls DROP COLUMN IF EXISTS spend_meter;

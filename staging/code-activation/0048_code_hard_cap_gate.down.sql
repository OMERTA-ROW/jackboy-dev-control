-- PROPOSED ROLLBACK for 0048_code_hard_cap_gate.sql. Run only with explicit owner approval.
-- Forces provider_hard_cap_verified back to false and restores 0037's forced-false CHECK, so no
-- task can be admitted. Refuses while a task is active. Audit history is kept.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.code_runtime_controls WHERE active_request_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Engage the Emergency Stop and wait for the active task to end before rolling back';
  END IF;
END;
$$;

UPDATE public.code_runtime_controls
  SET provider_hard_cap_verified = false, enabled = false, kill_switch = true, updated_at = now()
  WHERE singleton = true;

DROP FUNCTION public.set_code_provider_hard_cap_verified(uuid, boolean, text);
DROP TRIGGER code_runtime_controls_hard_cap_gate ON public.code_runtime_controls;
DROP FUNCTION public.code_runtime_controls_hard_cap_gate();

ALTER TABLE public.code_runtime_controls
  ADD CONSTRAINT code_runtime_controls_provider_hard_cap_verified_check
  CHECK (provider_hard_cap_verified = false);

COMMENT ON COLUMN public.code_runtime_controls.provider_hard_cap_verified IS NULL;

INSERT INTO public.audit_logs(actor, action, detail, outcome)
  VALUES (NULL, 'code.hard_cap_gate_rolled_back', '{"provider_hard_cap_verified": false}'::jsonb, 'ok');

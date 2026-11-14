-- Forward-only fix: preserve the installed 0066 bytes and serialize permit operations
-- with both stop-control rows. Reconcile this proposed number against live history first.
ALTER FUNCTION public.omni_execution_permit_action(text, jsonb)
  RENAME TO omni_execution_permit_action_unlocked;

REVOKE ALL ON FUNCTION public.omni_execution_permit_action_unlocked(text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.omni_execution_permit_action(_op text, _a jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- Acquire before the inner function takes its client advisory lock and permit row locks.
  PERFORM 1 FROM public.automation_policy WHERE id = 1 FOR SHARE;
  PERFORM 1 FROM public.code_runtime_controls WHERE singleton = true FOR SHARE;
  RETURN public.omni_execution_permit_action_unlocked(_op, _a);
END $$;

REVOKE ALL ON FUNCTION public.omni_execution_permit_action(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.omni_execution_permit_action(text, jsonb) TO service_role;

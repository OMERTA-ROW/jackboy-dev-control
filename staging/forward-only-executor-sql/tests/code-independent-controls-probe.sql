-- Local-only regression test. Run after the six bundle files on an isolated PostgreSQL fixture.
DO $test$
BEGIN
  IF public.code_independent_controls_installed() IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'the probe must recognize all three guarded CODE routines';
  END IF;
END;
$test$;

BEGIN;
CREATE OR REPLACE FUNCTION public.claim_code_runtime_slot(
  p_request_id uuid,
  p_repository text,
  p_ref text,
  p_workflow_sha text,
  p_run_id bigint
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $probe_test$
BEGIN
  RETURN false;
END;
$probe_test$;

DO $test$
BEGIN
  IF public.code_independent_controls_installed() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'the probe must reject a CODE routine missing the paused check';
  END IF;
END;
$test$;
ROLLBACK;

DO $test$
BEGIN
  IF public.code_independent_controls_installed() IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'the probe must recover after the temporary negative case rolls back';
  END IF;
END;
$test$;

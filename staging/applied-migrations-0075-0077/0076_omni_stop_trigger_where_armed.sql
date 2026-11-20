CREATE OR REPLACE FUNCTION public.omni_execution_stop_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF TG_TABLE_NAME='automation_policy' THEN
    PERFORM 1 FROM public.code_runtime_controls WHERE singleton FOR UPDATE;
  END IF;
  IF (TG_TABLE_NAME='code_runtime_controls' AND (
      (to_jsonb(NEW)->>'kill_switch')::boolean IS DISTINCT FROM false
      OR (to_jsonb(NEW)->>'enabled')::boolean IS DISTINCT FROM true))
    OR (TG_TABLE_NAME='automation_policy' AND (to_jsonb(NEW)->>'paused')::boolean IS DISTINCT FROM false)
  THEN
    UPDATE public.omni_execution_connections SET armed=false WHERE armed;
    UPDATE public.omni_execution_jobs SET state='cancel_requested',cancel_delivered=false
      WHERE state IN ('authorized','running');
  END IF;
  RETURN NEW;
END $function$;

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = 'public.omni_execution_stop_trigger()'::pg_catalog.regprocedure
      AND prosrc LIKE '%SET armed=false WHERE armed%'
  ) THEN
    RAISE EXCEPTION '0076 check failed: omni_execution_stop_trigger() does not contain the WHERE armed update';
  END IF;
END $check$;
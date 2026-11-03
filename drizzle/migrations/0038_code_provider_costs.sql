ALTER TABLE public.code_usage_events
  DROP CONSTRAINT code_usage_events_source_check,
  ADD CONSTRAINT code_usage_events_source_check
    CHECK (source IN ('openai_org_usage', 'openai_org_costs'));

ALTER TABLE public.code_runtime_controls
  ADD COLUMN provider_costs_synced_at timestamptz;

CREATE OR REPLACE FUNCTION public.record_code_provider_costs(
  p_actor uuid,
  p_rows jsonb,
  p_synced_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  report_total numeric(12,6);
  report_day timestamptz;
  row_count integer;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only the owner can sync CODE provider costs';
  END IF;
  IF p_rows IS NULL
    OR jsonb_typeof(p_rows) <> 'array'
    OR jsonb_array_length(p_rows) < 1
    OR jsonb_array_length(p_rows) > 1800
    OR p_synced_at IS NULL
    OR p_synced_at > now() + interval '30 seconds'
  THEN
    RAISE EXCEPTION 'Invalid CODE provider cost report';
  END IF;

  report_day := date_trunc('day', p_synced_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_rows) AS row_data(
      provider_event_id text,
      source text,
      occurred_at timestamptz,
      cost_usd numeric,
      request_id uuid
    )
    WHERE row_data.provider_event_id IS NULL
      OR row_data.provider_event_id !~ '^[a-f0-9]{64}$'
      OR row_data.source IS DISTINCT FROM 'openai_org_costs'
      OR row_data.occurred_at IS NULL
      OR row_data.cost_usd IS NULL
      OR row_data.cost_usd < 0
      OR row_data.request_id IS NOT NULL
      OR date_trunc('day', row_data.occurred_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        IS DISTINCT FROM report_day
  ) THEN
    RAISE EXCEPTION 'CODE provider cost report contains invalid or out-of-day rows';
  END IF;

  SELECT count(*)::integer, coalesce(sum(cost_usd), 0)
    INTO row_count, report_total
    FROM jsonb_to_recordset(p_rows) AS row_data(
      provider_event_id text,
      source text,
      occurred_at timestamptz,
      cost_usd numeric,
      request_id uuid
    );
  IF row_count <> jsonb_array_length(p_rows) THEN
    RAISE EXCEPTION 'Invalid CODE provider cost report rows';
  END IF;

  INSERT INTO public.code_usage_events(
    provider_event_id, source, occurred_at, cost_usd, request_id
  )
  SELECT provider_event_id, source, occurred_at, cost_usd, request_id
  FROM jsonb_to_recordset(p_rows) AS row_data(
    provider_event_id text,
    source text,
    occurred_at timestamptz,
    cost_usd numeric,
    request_id uuid
  )
  ON CONFLICT (provider_event_id) DO UPDATE
    SET source = EXCLUDED.source,
        occurred_at = EXCLUDED.occurred_at,
        cost_usd = EXCLUDED.cost_usd,
        request_id = EXCLUDED.request_id;

  UPDATE public.code_runtime_controls
    SET provider_costs_synced_at = p_synced_at,
        updated_at = now()
    WHERE singleton = true;

  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (
      p_actor,
      'code.provider_costs_synced',
      jsonb_build_object(
        'source', 'openai_org_costs',
        'utc_day', report_day,
        'reported_cost_usd', report_total,
        'bucket_count', row_count
      ),
      'reported'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.record_code_provider_costs(uuid, jsonb, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_code_provider_costs(uuid, jsonb, timestamptz)
  TO service_role;

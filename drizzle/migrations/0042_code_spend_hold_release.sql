-- Owner-authorised release of unsettled CODE spend holds that 0040's same-day reconcile can never
-- settle (holds that cross a UTC day, or whose own day never received a post-finish report).
--
-- A hold is released ONLY when authoritative provider cost evidence covers every UTC day the task
-- touched. A date change or a timeout alone never releases anything. Anything uncertain stays reserved.
-- This migration does not touch the 0037 provider_hard_cap_verified CHECK or the claim/finish functions.

ALTER TABLE public.code_runtime_controls
  ADD COLUMN closed_day_lag_seconds integer NOT NULL DEFAULT 21600
    CHECK (closed_day_lag_seconds BETWEEN 3600 AND 172800);

-- Append-only evidence: one row per owner-recorded provider cost report for a CLOSED UTC day.
CREATE TABLE public.code_provider_cost_day_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  utc_day date NOT NULL,
  synced_at timestamptz NOT NULL,
  reported_cost_usd numeric(12,6) NOT NULL CHECK (reported_cost_usd >= 0),
  bucket_count integer NOT NULL CHECK (bucket_count BETWEEN 1 AND 1800),
  recorded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (synced_at >= ((utc_day + 1)::timestamp AT TIME ZONE 'UTC'))
);
CREATE INDEX code_provider_cost_day_reports_day ON public.code_provider_cost_day_reports(utc_day, synced_at);
ALTER TABLE public.code_provider_cost_day_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.code_provider_cost_day_reports FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.code_provider_cost_day_reports TO service_role;

CREATE FUNCTION public.guard_code_provider_cost_day_report()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'CODE provider cost day reports are append-only evidence';
END;
$$;
CREATE TRIGGER code_provider_cost_day_reports_guard
  BEFORE UPDATE OR DELETE ON public.code_provider_cost_day_reports
  FOR EACH ROW EXECUTE FUNCTION public.guard_code_provider_cost_day_report();
REVOKE ALL ON FUNCTION public.guard_code_provider_cost_day_report() FROM PUBLIC, anon, authenticated;

-- Records a provider cost report for a day that has already ended, at least closed_day_lag_seconds
-- after it ended (providers publish daily buckets late). Same row validation as the live sync.
CREATE FUNCTION public.record_code_closed_day_costs(
  p_actor uuid,
  p_day date,
  p_rows jsonb,
  p_synced_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  controls public.code_runtime_controls%ROWTYPE;
  report_start timestamptz;
  row_count integer;
  report_total numeric(12,6);
  report_id uuid;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only the owner can record closed-day CODE provider costs';
  END IF;
  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;
  IF p_day IS NULL OR p_synced_at IS NULL OR p_rows IS NULL
    OR jsonb_typeof(p_rows) <> 'array'
    OR jsonb_array_length(p_rows) < 1
    OR jsonb_array_length(p_rows) > 1800
    OR p_synced_at > now() + interval '30 seconds'
    OR p_day >= (now() AT TIME ZONE 'UTC')::date
    OR p_synced_at < ((p_day + 1)::timestamp AT TIME ZONE 'UTC')
      + make_interval(secs => controls.closed_day_lag_seconds)
  THEN
    RAISE EXCEPTION 'Invalid closed-day CODE provider cost report';
  END IF;

  report_start := p_day::timestamp AT TIME ZONE 'UTC';
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_rows) AS row_data(
      provider_event_id text, source text, occurred_at timestamptz, cost_usd numeric, request_id uuid
    )
    WHERE row_data.provider_event_id IS NULL
      OR row_data.provider_event_id !~ '^[a-f0-9]{64}$'
      OR row_data.source IS DISTINCT FROM 'openai_org_costs'
      OR row_data.occurred_at IS NULL
      OR row_data.cost_usd IS NULL
      OR row_data.cost_usd < 0
      OR row_data.request_id IS NOT NULL
      OR row_data.occurred_at IS DISTINCT FROM report_start
  ) THEN
    RAISE EXCEPTION 'Closed-day CODE provider cost report contains invalid or out-of-day rows';
  END IF;

  SELECT count(*)::integer, coalesce(sum(cost_usd), 0)
    INTO row_count, report_total
    FROM jsonb_to_recordset(p_rows) AS row_data(
      provider_event_id text, source text, occurred_at timestamptz, cost_usd numeric, request_id uuid
    );

  INSERT INTO public.code_usage_events(provider_event_id, source, occurred_at, cost_usd, request_id)
  SELECT provider_event_id, source, occurred_at, cost_usd, request_id
  FROM jsonb_to_recordset(p_rows) AS row_data(
    provider_event_id text, source text, occurred_at timestamptz, cost_usd numeric, request_id uuid
  )
  ON CONFLICT (provider_event_id) DO UPDATE
    SET source = EXCLUDED.source,
        occurred_at = EXCLUDED.occurred_at,
        cost_usd = EXCLUDED.cost_usd,
        request_id = EXCLUDED.request_id;

  INSERT INTO public.code_provider_cost_day_reports(utc_day, synced_at, reported_cost_usd, bucket_count, recorded_by)
    VALUES (p_day, p_synced_at, report_total, row_count, p_actor)
    RETURNING id INTO report_id;

  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (p_actor, 'code.closed_day_costs_recorded',
      jsonb_build_object('source', 'openai_org_costs', 'utc_day', p_day,
        'reported_cost_usd', report_total, 'bucket_count', row_count, 'report_id', report_id),
      'reported');
  RETURN report_id;
END;
$$;

-- Releases specific, explicitly named finished holds. All-or-nothing: if ANY named hold lacks
-- evidence, nothing is released and the call fails. Already-settled holds are skipped (idempotent).
CREATE FUNCTION public.release_code_spend_holds(
  p_actor uuid,
  p_request_ids uuid[],
  p_reason text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  controls public.code_runtime_controls%ROWTYPE;
  hold public.code_spend_reservations%ROWTYPE;
  v_id uuid;
  day_value date;
  first_day date;
  last_day date;
  covered boolean;
  evidence jsonb := '[]'::jsonb;
  day_evidence jsonb;
  released_count integer := 0;
  released_total numeric(12,6) := 0;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = p_actor AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only the owner can release CODE spend holds';
  END IF;
  IF p_request_ids IS NULL
    OR cardinality(p_request_ids) < 1
    OR cardinality(p_request_ids) > 50
    OR array_position(p_request_ids, NULL) IS NOT NULL
    OR (SELECT count(DISTINCT x) FROM unnest(p_request_ids) AS x) <> cardinality(p_request_ids)
    OR p_reason IS NULL
    OR length(btrim(p_reason)) NOT BETWEEN 10 AND 500
  THEN
    RAISE EXCEPTION 'Invalid CODE spend hold release request';
  END IF;

  SELECT * INTO controls FROM public.code_runtime_controls WHERE singleton = true FOR UPDATE;

  FOREACH v_id IN ARRAY p_request_ids LOOP
    SELECT * INTO hold FROM public.code_spend_reservations WHERE code_spend_reservations.request_id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CODE spend hold % does not exist', v_id;
    END IF;
    IF hold.status = 'settled' THEN
      CONTINUE;
    END IF;
    IF hold.status <> 'finished' OR hold.finished_at IS NULL THEN
      RAISE EXCEPTION 'CODE spend hold % is not finished; it stays reserved', v_id;
    END IF;

    first_day := (hold.created_at AT TIME ZONE 'UTC')::date;
    last_day := (hold.finished_at AT TIME ZONE 'UTC')::date;
    day_evidence := '[]'::jsonb;
    FOR day_value IN SELECT g::date FROM generate_series(first_day::timestamp, last_day::timestamp, interval '1 day') AS g LOOP
      covered := false;
      -- Closed-day report, recorded after the day ended + lag and after the task finished + grace.
      PERFORM 1 FROM public.code_provider_cost_day_reports r
        WHERE r.utc_day = day_value
          AND r.synced_at >= ((day_value + 1)::timestamp AT TIME ZONE 'UTC')
            + make_interval(secs => controls.closed_day_lag_seconds)
          AND r.synced_at >= hold.finished_at + make_interval(secs => controls.reconcile_grace_seconds)
        LIMIT 1;
      IF FOUND THEN
        covered := true;
        day_evidence := day_evidence || jsonb_build_object('day', day_value, 'kind', 'closed_day_report');
      ELSIF day_value = last_day
        AND controls.provider_costs_synced_at IS NOT NULL
        AND controls.provider_costs_synced_at <= now() + interval '30 seconds'
        AND (controls.provider_costs_synced_at AT TIME ZONE 'UTC')::date = day_value
        AND controls.provider_costs_synced_at >= hold.finished_at + make_interval(secs => controls.reconcile_grace_seconds)
      THEN
        covered := true;
        day_evidence := day_evidence || jsonb_build_object('day', day_value, 'kind', 'live_report_after_finish');
      END IF;
      IF NOT covered THEN
        RAISE EXCEPTION 'CODE spend hold % has no authoritative provider cost evidence for UTC day %; it stays reserved', v_id, day_value;
      END IF;
    END LOOP;

    UPDATE public.code_spend_reservations
      SET status = 'settled', released_usd = reserved_usd, settled_at = now()
      WHERE code_spend_reservations.request_id = v_id;
    released_count := released_count + 1;
    released_total := released_total + hold.reserved_usd;
    evidence := evidence || jsonb_build_object('request_id', v_id, 'days', day_evidence);
  END LOOP;

  INSERT INTO public.audit_logs(actor, action, detail, outcome)
    VALUES (p_actor, 'code.spend_holds_released',
      jsonb_build_object('released', released_count, 'released_usd', released_total,
        'reason', btrim(p_reason), 'evidence', evidence), 'released');
  RETURN released_count;
END;
$$;

REVOKE ALL ON FUNCTION public.record_code_closed_day_costs(uuid, date, jsonb, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_code_spend_holds(uuid, uuid[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_code_closed_day_costs(uuid, date, jsonb, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_code_spend_holds(uuid, uuid[], text) TO service_role;
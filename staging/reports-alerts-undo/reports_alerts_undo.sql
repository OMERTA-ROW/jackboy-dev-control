-- Daily report, phone alerts and CODE undo storage. Owners read; only the server (service role) writes.
CREATE TABLE public.owner_alert_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  timezone text NOT NULL DEFAULT 'America/New_York' CHECK (char_length(timezone) BETWEEN 3 AND 64),
  report_hour smallint NOT NULL DEFAULT 7 CHECK (report_hour BETWEEN 0 AND 23),
  alerts_enabled boolean NOT NULL DEFAULT true,
  quiet_start smallint CHECK (quiet_start BETWEEN 0 AND 23),
  quiet_end smallint CHECK (quiet_end BETWEEN 0 AND 23),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
GRANT SELECT ON public.owner_alert_settings TO authenticated;
GRANT ALL ON public.owner_alert_settings TO service_role;
ALTER TABLE public.owner_alert_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads alert settings" ON public.owner_alert_settings FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));

CREATE TABLE public.push_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  token text NOT NULL UNIQUE CHECK (char_length(token) BETWEEN 20 AND 4096),
  label text NOT NULL DEFAULT 'This device' CHECK (char_length(label) BETWEEN 1 AND 80),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  last_error text
);
GRANT SELECT ON public.push_devices TO authenticated;
GRANT ALL ON public.push_devices TO service_role;
ALTER TABLE public.push_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads own push devices" ON public.push_devices FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role));

CREATE TABLE public.owner_alert_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE CHECK (char_length(dedupe_key) BETWEEN 3 AND 200),
  kind text NOT NULL CHECK (kind IN ('passkey_needed','github_approval','auto_stop','spend_warning','pr_ready','daily_report','test')),
  urgent boolean NOT NULL DEFAULT false,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 600),
  link text NOT NULL DEFAULT '/' CHECK (link LIKE '/%' AND char_length(link) <= 300),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  attempts smallint NOT NULL DEFAULT 0,
  last_error text,
  reminder boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX owner_alert_outbox_pending_idx ON public.owner_alert_outbox (status, created_at);
GRANT SELECT ON public.owner_alert_outbox TO authenticated;
GRANT ALL ON public.owner_alert_outbox TO service_role;
ALTER TABLE public.owner_alert_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads alerts" ON public.owner_alert_outbox FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));

CREATE TABLE public.daily_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_date date NOT NULL UNIQUE,
  generated_at timestamptz NOT NULL DEFAULT now(),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 4000),
  body jsonb NOT NULL DEFAULT '{}'::jsonb
);
GRANT SELECT ON public.daily_reports TO authenticated;
GRANT ALL ON public.daily_reports TO service_role;
ALTER TABLE public.daily_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads daily reports" ON public.daily_reports FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));

CREATE TABLE public.code_undos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  repo text NOT NULL,
  pr_number integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('close_draft','revert_merged')),
  status text NOT NULL DEFAULT 'started' CHECK (status IN ('started','waiting_checks','done','failed','refused')),
  revert_pr_number integer,
  revert_pr_url text,
  revert_head_sha text,
  merged_sha text,
  republish_needed boolean NOT NULL DEFAULT false,
  detail text,
  actor uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
GRANT SELECT ON public.code_undos TO authenticated;
GRANT ALL ON public.code_undos TO service_role;
ALTER TABLE public.code_undos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads code undos" ON public.code_undos FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));

ALTER TABLE public.owner_projects
  ADD COLUMN github_repo text,
  ADD COLUMN github_branch text NOT NULL DEFAULT 'main',
  ADD COLUMN frequency_hours int NOT NULL DEFAULT 24,
  ADD COLUMN last_run_at timestamptz;

ALTER TABLE public.update_proposals DROP CONSTRAINT IF EXISTS update_proposals_status_check;
ALTER TABLE public.update_proposals ADD CONSTRAINT update_proposals_status_check
  CHECK (status IN ('draft','approved','rejected','sent_to_omni','pr_open','merged','reverted'));
ALTER TABLE public.update_proposals
  ADD COLUMN files jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN feed_item_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN branch_name text,
  ADD COLUMN pr_number int,
  ADD COLUMN pr_url text,
  ADD COLUMN head_sha text,
  ADD COLUMN merge_sha text,
  ADD COLUMN revert_pr_url text,
  ADD COLUMN checks_state text,
  ADD COLUMN delivery_error text;

ALTER TABLE public.update_writer_settings
  ADD COLUMN monthly_ai_cap int NOT NULL DEFAULT 100,
  ADD COLUMN monthly_run_cap int NOT NULL DEFAULT 60;

CREATE TABLE public.feed_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('rss','page','webhook')),
  name text NOT NULL,
  url text,
  project_ids uuid[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  token_hash text,
  last_hash text,
  last_checked_at timestamptz,
  last_error text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feed_sources TO authenticated;
GRANT ALL ON public.feed_sources TO service_role;
ALTER TABLE public.feed_sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner manages feed sources" ON public.feed_sources FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'owner')) WITH CHECK (public.has_role(auth.uid(),'owner'));

CREATE TABLE public.feed_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES public.feed_sources(id) ON DELETE CASCADE,
  dedupe_key text NOT NULL UNIQUE,
  title text NOT NULL,
  url text,
  summary text NOT NULL DEFAULT '',
  published_at timestamptz,
  project_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feed_items_created ON public.feed_items(created_at DESC);
GRANT SELECT, UPDATE, DELETE ON public.feed_items TO authenticated;
GRANT ALL ON public.feed_items TO service_role;
ALTER TABLE public.feed_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads feed items" ON public.feed_items FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'owner'));
CREATE POLICY "owner edits feed items" ON public.feed_items FOR UPDATE TO authenticated USING (public.has_role(auth.uid(),'owner')) WITH CHECK (public.has_role(auth.uid(),'owner'));
CREATE POLICY "owner deletes feed items" ON public.feed_items FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'owner'));

CREATE TABLE public.usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('ai','run')),
  project_id uuid,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_ledger_kind_at ON public.usage_ledger(kind, at DESC);
GRANT SELECT ON public.usage_ledger TO authenticated;
GRANT ALL ON public.usage_ledger TO service_role;
ALTER TABLE public.usage_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads usage" ON public.usage_ledger FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'owner'));

CREATE TABLE public.owner_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  message text NOT NULL,
  proposal_id uuid,
  read boolean NOT NULL DEFAULT false,
  email_state text NOT NULL DEFAULT 'not_configured',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE, DELETE ON public.owner_notifications TO authenticated;
GRANT ALL ON public.owner_notifications TO service_role;
ALTER TABLE public.owner_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads notifications" ON public.owner_notifications FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'owner'));
CREATE POLICY "owner updates notifications" ON public.owner_notifications FOR UPDATE TO authenticated USING (public.has_role(auth.uid(),'owner')) WITH CHECK (public.has_role(auth.uid(),'owner'));
CREATE POLICY "owner deletes notifications" ON public.owner_notifications FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'owner'));
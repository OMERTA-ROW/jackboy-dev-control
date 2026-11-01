ALTER TABLE public.owner_projects ADD COLUMN client_key text NOT NULL DEFAULT ('jbp_' || replace(gen_random_uuid()::text,'-',''));
CREATE UNIQUE INDEX owner_projects_client_key ON public.owner_projects(client_key);

CREATE TABLE public.releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.owner_projects(id) ON DELETE CASCADE,
  version text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'),
  channel text NOT NULL CHECK (channel IN ('test','beta','live')),
  notes text NOT NULL DEFAULT '',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','rolling','paused','complete','rolled_back')),
  rollout_percent int NOT NULL DEFAULT 10 CHECK (rollout_percent BETWEEN 0 AND 100),
  auto_step int NOT NULL DEFAULT 0 CHECK (auto_step BETWEEN 0 AND 100),
  step_hours int NOT NULL DEFAULT 24 CHECK (step_hours BETWEEN 1 AND 720),
  last_step_at timestamptz,
  error_threshold numeric NOT NULL DEFAULT 5 CHECK (error_threshold > 0 AND error_threshold <= 100),
  min_reports int NOT NULL DEFAULT 20 CHECK (min_reports >= 1),
  artifact_path text,
  artifact_sha256 text,
  artifact_size bigint,
  manifest jsonb,
  signature text,
  rollback_reason text,
  published_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, channel, version)
);
CREATE INDEX releases_lookup ON public.releases(project_id, channel, status, published_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.releases TO authenticated;
GRANT ALL ON public.releases TO service_role;
ALTER TABLE public.releases ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner manages releases" ON public.releases FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'owner')) WITH CHECK (public.has_role(auth.uid(),'owner'));

CREATE TABLE public.feature_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.owner_projects(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('test','beta','live')),
  key text NOT NULL CHECK (key ~ '^[a-z0-9_.-]{1,64}$'),
  enabled boolean NOT NULL DEFAULT false,
  rollout_percent int NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100),
  description text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, channel, key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feature_flags TO authenticated;
GRANT ALL ON public.feature_flags TO service_role;
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner manages flags" ON public.feature_flags FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'owner')) WITH CHECK (public.has_role(auth.uid(),'owner'));

CREATE TABLE public.health_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.owner_projects(id) ON DELETE CASCADE,
  release_id uuid REFERENCES public.releases(id) ON DELETE SET NULL,
  version text NOT NULL,
  channel text NOT NULL,
  device_hash text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ok','error','crash')),
  message text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX health_reports_release ON public.health_reports(release_id, created_at DESC);
CREATE INDEX health_reports_device ON public.health_reports(device_hash, created_at DESC);
GRANT SELECT, DELETE ON public.health_reports TO authenticated;
GRANT ALL ON public.health_reports TO service_role;
ALTER TABLE public.health_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads health" ON public.health_reports FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'owner'));
CREATE POLICY "owner deletes health" ON public.health_reports FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'owner'));
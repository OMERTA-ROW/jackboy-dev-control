CREATE TABLE public.site_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  project_id uuid,
  actor text NOT NULL,
  action text NOT NULL,
  category text NOT NULL DEFAULT 'activity' CHECK (category IN ('activity','inspection','patch','test','approval','deployment','error','rollback','research','delivery','config')),
  status text NOT NULL DEFAULT 'info' CHECK (status IN ('info','ok','pending','blocked','failed','rolled_back')),
  summary text NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 2000),
  issue text, source_url text, license text,
  repo text, branch text, commit_sha text, pr_url text,
  tests text, task_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX site_log_at_idx ON public.site_log(at DESC);
CREATE INDEX site_log_project_idx ON public.site_log(project_id, at DESC);
GRANT SELECT ON public.site_log TO authenticated;
GRANT SELECT, INSERT ON public.site_log TO service_role;
ALTER TABLE public.site_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads site log" ON public.site_log FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));
CREATE OR REPLACE FUNCTION public.site_log_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Site log is append-only'; END $$;
CREATE TRIGGER site_log_no_change BEFORE UPDATE OR DELETE ON public.site_log FOR EACH ROW EXECUTE FUNCTION public.site_log_immutable();

CREATE TABLE public.log_subscriptions (
  target text PRIMARY KEY CHECK (target IN ('razul','omni','jax')),
  enabled boolean NOT NULL DEFAULT false,
  categories text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.log_subscriptions (target, enabled, categories) VALUES
 ('razul', true, '{}'), ('omni', true, '{inspection,patch,test,approval,deployment,error,rollback}'), ('jax', false, '{deployment}')
ON CONFLICT DO NOTHING;
GRANT SELECT ON public.log_subscriptions TO authenticated;
GRANT ALL ON public.log_subscriptions TO service_role;
ALTER TABLE public.log_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads subscriptions" ON public.log_subscriptions FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));

CREATE TABLE public.log_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  log_id uuid NOT NULL REFERENCES public.site_log(id),
  target text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (log_id, target)
);
CREATE INDEX log_outbox_due_idx ON public.log_outbox(status, next_attempt_at);
GRANT SELECT ON public.log_outbox TO authenticated;
GRANT ALL ON public.log_outbox TO service_role;
ALTER TABLE public.log_outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads outbox" ON public.log_outbox FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'::app_role));

CREATE OR REPLACE FUNCTION public.site_log_enqueue() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.log_outbox (log_id, target)
  SELECT NEW.id, s.target FROM public.log_subscriptions s
  WHERE s.enabled AND (cardinality(s.categories) = 0 OR NEW.category = ANY(s.categories))
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER site_log_outbox AFTER INSERT ON public.site_log FOR EACH ROW EXECUTE FUNCTION public.site_log_enqueue();

ALTER TABLE public.foundry_patterns ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE public.foundry_patterns ADD COLUMN IF NOT EXISTS license text;
ALTER TABLE public.foundry_patterns ADD COLUMN IF NOT EXISTS license_ok boolean NOT NULL DEFAULT false;
ALTER TABLE public.foundry_patterns ADD COLUMN IF NOT EXISTS score int NOT NULL DEFAULT 0;
ALTER TABLE public.foundry_patterns ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'foundry';
ALTER TABLE public.foundry_patterns ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
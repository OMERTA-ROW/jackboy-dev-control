CREATE TABLE public.razul_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  razul_id text NOT NULL UNIQUE,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  field text NOT NULL DEFAULT 'general',
  evidence text NOT NULL,
  observed_at timestamptz NOT NULL,
  sources jsonb NOT NULL,
  confidence real,
  priority int NOT NULL DEFAULT 0,
  project_id uuid REFERENCES public.agent_projects(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'new',
  imported_by uuid NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT razul_evidence CHECK (evidence IN ('verified','peer_reviewed','primary_source','reported','hypothesis','historical')),
  CONSTRAINT razul_status CHECK (status IN ('new','proposed','tasked','dismissed')),
  CONSTRAINT razul_has_source CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) > 0)
);
GRANT SELECT ON public.razul_findings TO authenticated;
GRANT ALL ON public.razul_findings TO service_role;
ALTER TABLE public.razul_findings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read razul findings" ON public.razul_findings FOR SELECT TO authenticated USING (public.my_role() IS NOT NULL);

CREATE TABLE public.razul_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES public.razul_findings(id) ON DELETE CASCADE,
  outcome text NOT NULL,
  note text NOT NULL DEFAULT '',
  sent_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT razul_outcome CHECK (outcome IN ('useful','not_relevant','incorrect','built','test_passed','test_failed'))
);
GRANT SELECT ON public.razul_feedback TO authenticated;
GRANT ALL ON public.razul_feedback TO service_role;
ALTER TABLE public.razul_feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read razul feedback" ON public.razul_feedback FOR SELECT TO authenticated USING (public.my_role() IS NOT NULL);
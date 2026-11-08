-- Owner-scoped storage for OMNI research handoffs and JAX draft release manifests.
-- Replaces browser-only storage. Original browser records are kept verbatim in `original`
-- and can never be edited; records are archived, never deleted. Existing omni_jobs are untouched.

CREATE TABLE public.omni_research_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  source_local_id text CHECK (source_local_id IS NULL OR char_length(source_local_id) BETWEEN 1 AND 120),
  finding_id text NOT NULL DEFAULT '' CHECK (char_length(finding_id) <= 200),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 300),
  sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array' AND octet_length(sources::text) <= 20000),
  hypothesis text NOT NULL DEFAULT '' CHECK (char_length(hypothesis) <= 8000),
  novelty_caveat text NOT NULL DEFAULT '' CHECK (char_length(novelty_caveat) <= 4000),
  feasibility numeric NOT NULL DEFAULT 0 CHECK (feasibility >= 0 AND feasibility <= 5),
  requirements text NOT NULL DEFAULT '' CHECK (char_length(requirements) <= 20000),
  risk text NOT NULL DEFAULT 'medium' CHECK (risk IN ('low','medium','high')),
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
  est_cost numeric NOT NULL DEFAULT 0 CHECK (est_cost >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('draft','pending','approved','rejected')),
  revenue jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(revenue) = 'object' AND octet_length(revenue::text) <= 4000),
  provenance jsonb NOT NULL DEFAULT '{"ownershipConfirmed":false,"ossReviewed":false,"noScrapedOrUnlicensed":false,"notes":""}'::jsonb
    CHECK (jsonb_typeof(provenance) = 'object' AND octet_length(provenance::text) <= 8000),
  approvals jsonb NOT NULL DEFAULT '{"publish":false,"pricing":false,"deploy":false,"sell":false}'::jsonb
    CHECK (jsonb_typeof(approvals) = 'object' AND octet_length(approvals::text) <= 1000),
  original jsonb CHECK (original IS NULL OR octet_length(original::text) <= 100000),
  imported_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, source_local_id)
);
CREATE INDEX omni_research_handoffs_owner_idx ON public.omni_research_handoffs (owner_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON public.omni_research_handoffs TO authenticated;
GRANT ALL ON public.omni_research_handoffs TO service_role;
ALTER TABLE public.omni_research_handoffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads own research handoffs" ON public.omni_research_handoffs FOR SELECT TO authenticated
  USING (owner_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role));
CREATE POLICY "owner adds own research handoffs" ON public.omni_research_handoffs FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role));
CREATE POLICY "owner edits own research handoffs" ON public.omni_research_handoffs FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role))
  WITH CHECK (owner_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role));

CREATE TABLE public.jax_release_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,
  source_local_id text CHECK (source_local_id IS NULL OR char_length(source_local_id) BETWEEN 1 AND 120),
  handoff_id uuid REFERENCES public.omni_research_handoffs(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 300),
  version text NOT NULL DEFAULT '0.1.0' CHECK (char_length(version) BETWEEN 1 AND 40),
  simulated boolean NOT NULL DEFAULT true CHECK (simulated),
  manifest jsonb NOT NULL CHECK (
    jsonb_typeof(manifest) = 'object'
    AND octet_length(manifest::text) <= 100000
    AND coalesce(manifest->>'simulated', 'true') = 'true'
    AND (manifest->'actualRevenue' IS NULL OR manifest->'actualRevenue' = 'null'::jsonb)
  ),
  original jsonb CHECK (original IS NULL OR octet_length(original::text) <= 100000),
  imported_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, source_local_id)
);
CREATE INDEX jax_release_manifests_owner_idx ON public.jax_release_manifests (owner_id, created_at DESC);
GRANT SELECT, INSERT, UPDATE ON public.jax_release_manifests TO authenticated;
GRANT ALL ON public.jax_release_manifests TO service_role;
ALTER TABLE public.jax_release_manifests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner reads own jax manifests" ON public.jax_release_manifests FOR SELECT TO authenticated
  USING (owner_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role));
CREATE POLICY "owner adds own jax manifests" ON public.jax_release_manifests FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role)
    AND (handoff_id IS NULL OR EXISTS (SELECT 1 FROM public.omni_research_handoffs h WHERE h.id = handoff_id AND h.owner_id = auth.uid())));
CREATE POLICY "owner edits own jax manifests" ON public.jax_release_manifests FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role))
  WITH CHECK (owner_id = auth.uid() AND public.has_role(auth.uid(), 'owner'::app_role)
    AND (handoff_id IS NULL OR EXISTS (SELECT 1 FROM public.omni_research_handoffs h WHERE h.id = handoff_id AND h.owner_id = auth.uid())));

-- Original browser data, ownership and import facts can never change after insert.
CREATE OR REPLACE FUNCTION public.owner_records_keep_original()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.source_local_id IS DISTINCT FROM OLD.source_local_id
     OR NEW.original IS DISTINCT FROM OLD.original
     OR NEW.imported_at IS DISTINCT FROM OLD.imported_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'owner, import source, original record and creation time cannot be changed';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER omni_research_handoffs_keep_original BEFORE UPDATE ON public.omni_research_handoffs
  FOR EACH ROW EXECUTE FUNCTION public.owner_records_keep_original();
CREATE TRIGGER jax_release_manifests_keep_original BEFORE UPDATE ON public.jax_release_manifests
  FOR EACH ROW EXECUTE FUNCTION public.owner_records_keep_original();

-- Owner approvals follow the handoff rules on every write: nothing stays approved unless the
-- handoff is approved, and publish/pricing/sell also need the full provenance checklist.
CREATE OR REPLACE FUNCTION public.omni_research_handoff_approval_rules()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  cleared boolean := coalesce((NEW.provenance->>'ownershipConfirmed')::boolean, false)
    AND coalesce((NEW.provenance->>'ossReviewed')::boolean, false)
    AND coalesce((NEW.provenance->>'noScrapedOrUnlicensed')::boolean, false);
  approved boolean := NEW.status = 'approved';
BEGIN
  NEW.approvals := jsonb_build_object(
    'publish', approved AND cleared AND coalesce((NEW.approvals->>'publish')::boolean, false),
    'pricing', approved AND cleared AND coalesce((NEW.approvals->>'pricing')::boolean, false),
    'sell',    approved AND cleared AND coalesce((NEW.approvals->>'sell')::boolean, false),
    'deploy',  approved AND coalesce((NEW.approvals->>'deploy')::boolean, false)
  );
  RETURN NEW;
END $$;
CREATE TRIGGER omni_research_handoffs_approval_rules BEFORE INSERT OR UPDATE ON public.omni_research_handoffs
  FOR EACH ROW EXECUTE FUNCTION public.omni_research_handoff_approval_rules();
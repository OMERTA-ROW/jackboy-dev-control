CREATE TABLE public.foundry_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  project_id uuid,
  version text NOT NULL,
  package_sha256 text NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id)
);
GRANT SELECT ON public.foundry_packages TO authenticated;
GRANT ALL ON public.foundry_packages TO service_role;
ALTER TABLE public.foundry_packages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner reads packages" ON public.foundry_packages FOR SELECT TO authenticated USING (public.my_role() = 'owner');
CREATE OR REPLACE FUNCTION public.foundry_packages_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'update packages are immutable'; END $$;
CREATE TRIGGER foundry_packages_no_change BEFORE UPDATE OR DELETE ON public.foundry_packages FOR EACH ROW EXECUTE FUNCTION public.foundry_packages_immutable();
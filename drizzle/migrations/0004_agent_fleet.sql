CREATE TABLE public.agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.agent_projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL,
  specialty text NOT NULL DEFAULT '',
  autonomy text NOT NULL DEFAULT 'observe',
  paused boolean NOT NULL DEFAULT false,
  installed_verified boolean NOT NULL DEFAULT false,
  health text NOT NULL DEFAULT 'unknown',
  last_seen_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_category CHECK (category IN ('angeltech','demontech')),
  CONSTRAINT agent_autonomy CHECK (autonomy IN ('observe','propose','experiment')),
  CONSTRAINT agent_health CHECK (health IN ('unknown','ok','degraded','failing'))
);
GRANT SELECT, INSERT, DELETE ON public.agents TO authenticated;
-- installed_verified / health / last_seen_at are server-set only.
GRANT UPDATE (name, specialty, autonomy, paused) ON public.agents TO authenticated;
GRANT ALL ON public.agents TO service_role;
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read agents" ON public.agents FOR SELECT TO authenticated USING (public.my_role() IS NOT NULL);
CREATE POLICY "managers add agents" ON public.agents FOR INSERT TO authenticated
  WITH CHECK (public.is_manager(auth.uid()) AND created_by = auth.uid() AND installed_verified = false AND autonomy = 'observe');
CREATE POLICY "managers edit agents" ON public.agents FOR UPDATE TO authenticated USING (public.is_manager(auth.uid())) WITH CHECK (public.is_manager(auth.uid()));
CREATE POLICY "owner removes agents" ON public.agents FOR DELETE TO authenticated USING (public.has_role(auth.uid(),'owner'));
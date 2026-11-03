CREATE TABLE public.provider_permission_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid,
  provider text NOT NULL CHECK (provider IN ('github_app')),
  event text NOT NULL CHECK (event IN ('requested','approved','denied','applied','changed')),
  target text NOT NULL,
  permission text NOT NULL,
  before_access text,
  after_access text,
  reason text,
  actor uuid NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX provider_permission_decision_once
  ON public.provider_permission_events (request_id)
  WHERE request_id IS NOT NULL AND event IN ('approved','denied');
CREATE UNIQUE INDEX provider_permission_requested_once
  ON public.provider_permission_events (request_id)
  WHERE request_id IS NOT NULL AND event = 'requested';
CREATE UNIQUE INDEX provider_permission_applied_once
  ON public.provider_permission_events (request_id)
  WHERE request_id IS NOT NULL AND event = 'applied';
CREATE INDEX provider_permission_events_created_idx
  ON public.provider_permission_events (created_at DESC);
GRANT SELECT ON public.provider_permission_events TO authenticated;
GRANT ALL ON public.provider_permission_events TO service_role;
ALTER TABLE public.provider_permission_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "owner and admins read provider permission events"
  ON public.provider_permission_events FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'owner'::app_role) OR public.has_role(auth.uid(), 'admin'::app_role));
CREATE OR REPLACE FUNCTION public.provider_permission_events_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Provider permission events are append-only'; END $$;
CREATE TRIGGER provider_permission_events_no_change
  BEFORE UPDATE OR DELETE ON public.provider_permission_events
  FOR EACH ROW EXECUTE FUNCTION public.provider_permission_events_immutable();

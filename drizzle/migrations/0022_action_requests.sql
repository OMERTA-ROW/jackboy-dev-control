CREATE TABLE public.action_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid,
  task_id uuid,
  action text NOT NULL,
  tier text NOT NULL,
  resources jsonb NOT NULL DEFAULT '{}'::jsonb,
  permissions text[] NOT NULL DEFAULT '{}',
  diff_summary text NOT NULL DEFAULT '',
  risk text NOT NULL DEFAULT '',
  nonce_hash text NOT NULL,
  requested_by uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  mode text,
  expires_at timestamptz NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  outcome text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX action_requests_one_pending ON public.action_requests (task_id, action) WHERE status = 'pending';
GRANT SELECT ON public.action_requests TO authenticated;
GRANT ALL ON public.action_requests TO service_role;
ALTER TABLE public.action_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner reads action requests" ON public.action_requests FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'owner'));
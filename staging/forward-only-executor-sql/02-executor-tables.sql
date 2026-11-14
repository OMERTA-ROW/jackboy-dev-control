-- Only source-missing executor/permit tables. Do not create the Supabase auth schema.
-- The singleton row is required by the stop-generation stamping trigger.
BEGIN;

CREATE TABLE public.omni_autonomy_authorizations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  owner_id uuid NOT NULL,
  client_id text NOT NULL,
  project_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  step8_job_id uuid NOT NULL,
  daily_limit_usd numeric(10,2) DEFAULT 5.00 NOT NULL,
  per_call_limit_usd numeric(10,2) DEFAULT 0.50 NOT NULL,
  per_task_reserve_usd numeric(10,2) DEFAULT 1.00 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  revoked_at timestamp with time zone,
  revoked_reason text,
  capabilities text[] DEFAULT ARRAY['autonomous'::text, 'code'::text] NOT NULL
);

CREATE TABLE public.omni_execution_connections (
  project_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  connected boolean DEFAULT false NOT NULL,
  configured boolean DEFAULT false NOT NULL,
  executor_release text,
  verified_at timestamp with time zone,
  armed boolean DEFAULT false NOT NULL
);

CREATE TABLE public.omni_execution_jobs (
  id uuid NOT NULL,
  project_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  plan_sha256 text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  state text DEFAULT 'authorized'::text NOT NULL,
  claimed_at timestamp with time zone,
  finished_at timestamp with time zone,
  cancel_delivered boolean DEFAULT false NOT NULL,
  permit_id uuid,
  permit_issued_at timestamp with time zone,
  permit_expires_at timestamp with time zone,
  permit_renewals integer DEFAULT 0 NOT NULL,
  mothership_lease_expires_at timestamp with time zone,
  last_permission_at timestamp with time zone
);

CREATE TABLE public.omni_execution_permits (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  authorization_id uuid NOT NULL,
  client_id text NOT NULL,
  project_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  job_id uuid NOT NULL,
  job_kind text NOT NULL,
  payload_digest text NOT NULL,
  reserved_usd numeric(10,2) NOT NULL,
  status text NOT NULL,
  issued_at timestamp with time zone DEFAULT now() NOT NULL,
  renewed_at timestamp with time zone DEFAULT now() NOT NULL,
  renewals integer DEFAULT 0 NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  closed_at timestamp with time zone,
  closed_reason text,
  stop_generation bigint DEFAULT 0 NOT NULL
);

CREATE TABLE public.omni_link_approval (
  id smallint DEFAULT 1 NOT NULL,
  approval_id uuid NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  saved_by uuid NOT NULL,
  saved_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.omni_permit_safety_generation (
  singleton boolean DEFAULT true NOT NULL,
  generation bigint DEFAULT 1 NOT NULL
);

INSERT INTO public.omni_permit_safety_generation (singleton, generation)
VALUES (true, 1);

COMMIT;

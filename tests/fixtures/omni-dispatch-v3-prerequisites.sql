-- Synthetic prerequisites for isolated migration/type-generation tests only.
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
CREATE FUNCTION public.has_role(uuid,text) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE TABLE public.omni_jobs(id uuid PRIMARY KEY);
CREATE TABLE public.agent_projects(id uuid PRIMARY KEY);
CREATE TABLE public.user_roles(user_id uuid, role text);
CREATE TABLE public.omni_project_authorizations(
  id uuid PRIMARY KEY, expires_at timestamptz, revoked_at timestamptz
);
CREATE TABLE public.omni_dispatch_grants(
  id uuid PRIMARY KEY, job_id uuid, owner_id uuid, project_id uuid, repo text,
  kind text, expires_at timestamptz, revoked_at timestamptz, authorization_id uuid
);
CREATE FUNCTION public.omni_link_live() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
CREATE FUNCTION public.omni_dispatch_grant_action(text,uuid,uuid,uuid)
  RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;

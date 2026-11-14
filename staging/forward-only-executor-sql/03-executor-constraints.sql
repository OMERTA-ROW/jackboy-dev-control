-- Source constraints and indexes for the six new executor/permit tables only.
BEGIN;

ALTER TABLE ONLY public.omni_autonomy_authorizations ADD CONSTRAINT omni_autonomy_authorizations_check CHECK (((expires_at > created_at) AND (expires_at <= (created_at + '24:00:00'::interval))));
ALTER TABLE ONLY public.omni_autonomy_authorizations ADD CONSTRAINT omni_autonomy_authorizations_client_id_check CHECK ((client_id ~ '^[a-zA-Z0-9_-]{1,64}$'::text));
ALTER TABLE ONLY public.omni_autonomy_authorizations ADD CONSTRAINT omni_autonomy_authorizations_daily_limit_usd_check CHECK ((daily_limit_usd = 5.00));
ALTER TABLE ONLY public.omni_autonomy_authorizations ADD CONSTRAINT omni_autonomy_authorizations_per_call_limit_usd_check CHECK ((per_call_limit_usd = 0.50));
ALTER TABLE ONLY public.omni_autonomy_authorizations ADD CONSTRAINT omni_autonomy_authorizations_per_task_reserve_usd_check CHECK ((per_task_reserve_usd = 1.00));
ALTER TABLE ONLY public.omni_autonomy_authorizations ADD CONSTRAINT omni_autonomy_authorizations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.omni_autonomy_authorizations ADD CONSTRAINT omni_autonomy_authorizations_revoked_reason_check CHECK (((revoked_reason IS NULL) OR (char_length(revoked_reason) <= 300)));
ALTER TABLE ONLY public.omni_autonomy_authorizations ADD CONSTRAINT omni_autonomy_capabilities_allowed CHECK ((((cardinality(capabilities) >= 1) AND (cardinality(capabilities) <= 2)) AND (capabilities <@ ARRAY['autonomous'::text, 'code'::text]) AND (array_position(capabilities, NULL::text) IS NULL)));
ALTER TABLE ONLY public.omni_execution_connections ADD CONSTRAINT omni_execution_connections_pkey PRIMARY KEY (project_id);
ALTER TABLE ONLY public.omni_execution_jobs ADD CONSTRAINT omni_execution_jobs_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.omni_execution_jobs ADD CONSTRAINT omni_execution_jobs_plan_sha256_check CHECK ((plan_sha256 ~ '^[a-f0-9]{64}$'::text));
ALTER TABLE ONLY public.omni_execution_jobs ADD CONSTRAINT omni_execution_jobs_state_check CHECK ((state = ANY (ARRAY['authorized'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancel_requested'::text, 'cancelled'::text])));
ALTER TABLE ONLY public.omni_execution_permits ADD CONSTRAINT omni_execution_permits_check CHECK ((expires_at <= (renewed_at + '00:01:00'::interval)));
ALTER TABLE ONLY public.omni_execution_permits ADD CONSTRAINT omni_execution_permits_client_id_job_id_key UNIQUE (client_id, job_id);
ALTER TABLE ONLY public.omni_execution_permits ADD CONSTRAINT omni_execution_permits_job_kind_check CHECK ((job_kind = ANY (ARRAY['autonomous'::text, 'code'::text])));
ALTER TABLE ONLY public.omni_execution_permits ADD CONSTRAINT omni_execution_permits_payload_digest_check CHECK ((payload_digest ~ '^[a-f0-9]{64}$'::text));
ALTER TABLE ONLY public.omni_execution_permits ADD CONSTRAINT omni_execution_permits_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.omni_execution_permits ADD CONSTRAINT omni_execution_permits_renewals_check CHECK ((renewals >= 0));
ALTER TABLE ONLY public.omni_execution_permits ADD CONSTRAINT omni_execution_permits_reserved_usd_check CHECK ((reserved_usd = 1.00));
ALTER TABLE ONLY public.omni_execution_permits ADD CONSTRAINT omni_execution_permits_status_check CHECK ((status = ANY (ARRAY['active'::text, 'released'::text, 'revoked'::text, 'expired'::text])));
ALTER TABLE ONLY public.omni_link_approval ADD CONSTRAINT omni_link_approval_id_check CHECK ((id = 1));
ALTER TABLE ONLY public.omni_link_approval ADD CONSTRAINT omni_link_approval_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.omni_permit_safety_generation ADD CONSTRAINT omni_permit_safety_generation_pkey PRIMARY KEY (singleton);
ALTER TABLE ONLY public.omni_permit_safety_generation ADD CONSTRAINT omni_permit_safety_generation_singleton_check CHECK (singleton);
ALTER TABLE ONLY public.omni_autonomy_authorizations ADD CONSTRAINT omni_autonomy_authorizations_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.owner_projects(id);
ALTER TABLE ONLY public.omni_autonomy_authorizations ADD CONSTRAINT omni_autonomy_authorizations_step8_job_id_fkey FOREIGN KEY (step8_job_id) REFERENCES public.omni_inbound_jobs(id);
ALTER TABLE ONLY public.omni_execution_connections ADD CONSTRAINT omni_execution_connections_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.omni_execution_connections ADD CONSTRAINT omni_execution_connections_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.owner_projects(id);
ALTER TABLE ONLY public.omni_execution_jobs ADD CONSTRAINT omni_execution_jobs_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id);
ALTER TABLE ONLY public.omni_execution_jobs ADD CONSTRAINT omni_execution_jobs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.omni_execution_connections(project_id);
ALTER TABLE ONLY public.omni_execution_permits ADD CONSTRAINT omni_execution_permits_authorization_id_fkey FOREIGN KEY (authorization_id) REFERENCES public.omni_autonomy_authorizations(id);
CREATE UNIQUE INDEX omni_autonomy_one_active ON public.omni_autonomy_authorizations USING btree (client_id) WHERE (revoked_at IS NULL);
CREATE INDEX omni_execution_permits_active ON public.omni_execution_permits USING btree (client_id, status);
CREATE INDEX omni_execution_permits_issued ON public.omni_execution_permits USING btree (issued_at);

COMMIT;

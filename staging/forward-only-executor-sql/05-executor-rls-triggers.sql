-- No FORCE RLS or policies are added; source has RLS enabled and no policies on these six tables.
BEGIN;

ALTER TABLE public.omni_autonomy_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_execution_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_execution_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_execution_permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_link_approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omni_permit_safety_generation ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON public.audit_logs FOR EACH STATEMENT EXECUTE FUNCTION public.audit_logs_immutable();
CREATE TRIGGER audit_logs_no_update_delete BEFORE DELETE OR UPDATE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.audit_logs_immutable();
CREATE TRIGGER omni_execution_global_stop AFTER UPDATE ON public.automation_policy FOR EACH ROW EXECUTE FUNCTION public.omni_execution_stop_trigger();
CREATE TRIGGER omni_permit_generation_global AFTER UPDATE OF paused ON public.automation_policy FOR EACH ROW EXECUTE FUNCTION public.omni_permit_generation_trigger();
CREATE TRIGGER omni_permits_revoke_on_kill_switch AFTER UPDATE OF paused ON public.automation_policy FOR EACH ROW EXECUTE FUNCTION public.omni_permits_revoke_on_stop();
CREATE TRIGGER code_provider_calls_total_guard AFTER INSERT OR UPDATE ON public.code_provider_calls FOR EACH STATEMENT EXECUTE FUNCTION public.code_total_spend_guard_trigger();
CREATE TRIGGER code_runtime_controls_activation_gate BEFORE INSERT OR UPDATE ON public.code_runtime_controls FOR EACH ROW EXECUTE FUNCTION public.code_runtime_controls_activation_gate();
CREATE TRIGGER code_runtime_controls_hard_cap_gate BEFORE INSERT OR UPDATE ON public.code_runtime_controls FOR EACH ROW EXECUTE FUNCTION public.code_runtime_controls_hard_cap_gate();
CREATE TRIGGER omni_execution_code_stop AFTER UPDATE ON public.code_runtime_controls FOR EACH ROW EXECUTE FUNCTION public.omni_execution_stop_trigger();
CREATE TRIGGER omni_permit_generation_code AFTER UPDATE OF enabled, kill_switch ON public.code_runtime_controls FOR EACH ROW EXECUTE FUNCTION public.omni_permit_generation_trigger();
CREATE TRIGGER omni_permits_revoke_on_emergency_stop AFTER UPDATE OF kill_switch, enabled ON public.code_runtime_controls FOR EACH ROW EXECUTE FUNCTION public.omni_permits_revoke_on_stop();
CREATE TRIGGER code_acceptance_reservation_guard BEFORE INSERT ON public.code_spend_reservations FOR EACH ROW EXECUTE FUNCTION public.guard_code_acceptance_reservation();
CREATE TRIGGER code_spend_reservations_total_guard AFTER INSERT ON public.code_spend_reservations FOR EACH ROW EXECUTE FUNCTION public.code_total_spend_guard_trigger();
CREATE TRIGGER code_usage_events_total_guard AFTER INSERT OR UPDATE ON public.code_usage_events FOR EACH STATEMENT EXECUTE FUNCTION public.code_total_spend_guard_trigger();
CREATE TRIGGER omni_autonomy_authorization_guard BEFORE DELETE OR UPDATE ON public.omni_autonomy_authorizations FOR EACH ROW EXECUTE FUNCTION public.omni_autonomy_authorization_guard();
CREATE TRIGGER omni_autonomy_authorization_no_truncate BEFORE TRUNCATE ON public.omni_autonomy_authorizations FOR EACH STATEMENT EXECUTE FUNCTION public.omni_autonomy_authorization_guard();
CREATE TRIGGER omni_execution_job_guard BEFORE UPDATE ON public.omni_execution_jobs FOR EACH ROW EXECUTE FUNCTION public.omni_execution_job_guard();
CREATE TRIGGER omni_execution_permit_closed AFTER UPDATE OF status ON public.omni_execution_permits FOR EACH ROW EXECUTE FUNCTION public.omni_execution_permit_closed();
CREATE TRIGGER omni_permit_generation_stamp BEFORE INSERT ON public.omni_execution_permits FOR EACH ROW EXECUTE FUNCTION public.omni_permit_generation_trigger();

COMMIT;

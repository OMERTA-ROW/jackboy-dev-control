-- Bridges a migration-chain gap so a completely empty database can replay 0001..0040.
--
-- 0031_repository_resync_drift_removals.sql and 0033_unified_project_repository_resync.sql build on
-- public.repository_resync_reviews, public.repository_reference_inventory(), the owner_projects guard
-- triggers and the apply_repository_resync wrapper/_internal pair. Those objects were created by three
-- migrations that exist only on the diverged lovable-sync history (0030_repository_resync_review,
-- 0031_repository_resync_guard_bound_work, 0032_scope_repository_resync_transaction_guard) and were
-- never part of main's numbered chain (main's 0030 is 0030_omni_sessions).
--
-- Every block below is guarded by the existence of the object it creates, so on any database that
-- already has the object (production) this file changes nothing. It never replaces, drops or alters
-- an existing object. Ordering: sorts after 0030_omni_sessions and before 0031_*.
--
-- The _internal function created here is a fail-closed placeholder: 0031_repository_resync_drift_removals
-- replaces it with the real body immediately afterwards in the same replay.

DO $baseline_a$
BEGIN
  IF to_regclass('public.repository_resync_reviews') IS NULL THEN
    EXECUTE $s$CREATE TABLE public.repository_resync_reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requested_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes', inventory jsonb NOT NULL, references_snapshot jsonb NOT NULL, approved_at timestamptz, replacements jsonb)$s$;
    EXECUTE 'GRANT SELECT ON public.repository_resync_reviews TO authenticated';
    EXECUTE 'GRANT ALL ON public.repository_resync_reviews TO service_role';
    EXECUTE 'ALTER TABLE public.repository_resync_reviews ENABLE ROW LEVEL SECURITY';
    EXECUTE $s$CREATE POLICY owner_review_read ON public.repository_resync_reviews FOR SELECT TO authenticated USING (requested_by=auth.uid() AND public.my_role()='owner')$s$;
  END IF;
  IF to_regprocedure('public.repository_reference_inventory()') IS NULL THEN
    EXECUTE $s$CREATE FUNCTION public.repository_reference_inventory() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $f$
 SELECT coalesce(jsonb_agg(r),'[]'::jsonb) FROM (
 SELECT 'owner_projects' AS "table", id::text, 'github_repo' AS field, github_repo AS value, true AS mutable FROM public.owner_projects WHERE github_repo IS NOT NULL
 UNION ALL SELECT 'agent_projects', id::text, 'repo_url', repo_url, true FROM public.agent_projects WHERE repo_url IS NOT NULL
 UNION ALL SELECT 'foundry_tasks', id::text, 'repo', repo, state IN ('discovered','blocked') AND branch IS NULL AND commit_sha IS NULL AND pr_number IS NULL AND approved_action IS NULL FROM public.foundry_tasks WHERE repo IS NOT NULL
 UNION ALL SELECT 'omni_jobs', id::text, 'repo', repo, status='queued' AND sent_at IS NULL AND code_request_id IS NULL FROM public.omni_jobs WHERE repo IS NOT NULL
 UNION ALL SELECT 'action_requests', id::text, 'resources.repo', resources->>'repo', false FROM public.action_requests WHERE resources->>'repo' IS NOT NULL
 UNION ALL SELECT 'site_log', id::text, 'repo', repo, false FROM public.site_log WHERE repo IS NOT NULL
 UNION ALL SELECT 'agent_memory', id::text, 'repo', repo, false FROM public.agent_memory WHERE repo IS NOT NULL
 ) r;
$f$$s$;
    EXECUTE 'REVOKE ALL ON FUNCTION public.repository_reference_inventory() FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.repository_reference_inventory() TO service_role';
  END IF;
END
$baseline_a$;

DO $baseline_b$
BEGIN
  IF to_regprocedure('public.guard_repository_resync_target()') IS NULL THEN
    EXECUTE $s$CREATE FUNCTION public.guard_repository_resync_target() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$
BEGIN
 IF NEW.github_repo IS DISTINCT FROM OLD.github_repo AND current_setting('jackboy.repository_resync',true)='on' THEN
 IF EXISTS(SELECT 1 FROM public.update_proposals WHERE project_id=OLD.id AND status NOT IN ('rejected','merged','reverted')) OR EXISTS(SELECT 1 FROM public.foundry_tasks WHERE project_id=OLD.id AND state NOT IN ('completed','failed','rolled_back','rejected') AND (branch IS NOT NULL OR commit_sha IS NOT NULL OR pr_number IS NOT NULL OR approved_action IS NOT NULL OR state NOT IN ('discovered','blocked'))) OR EXISTS(SELECT 1 FROM public.omni_jobs WHERE project_id=OLD.id AND (status IN ('sent','running') OR (status='queued' AND code_request_id IS NOT NULL))) OR EXISTS(SELECT 1 FROM public.action_requests WHERE project_id=OLD.id AND status IN ('pending','approved','executing')) THEN
 RAISE EXCEPTION 'Repository has approval-bound or running work. Resolve that work before replacing the target.';
 END IF;
 NEW.connect_state:='not_connected'; NEW.connect_error:='Repository changed by owner; reconnect required'; NEW.connect_pr_url:=NULL;
 END IF;
 RETURN NEW;
END;
$f$$s$;
  END IF;
  IF to_regprocedure('public.reset_resynced_repo_access()') IS NULL THEN
    EXECUTE $s$CREATE FUNCTION public.reset_resynced_repo_access() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$
BEGIN
 IF NEW.github_repo IS DISTINCT FROM OLD.github_repo AND current_setting('jackboy.repository_resync',true)='on' THEN
 UPDATE public.capability_grants SET last_verified_at=NULL,last_error='Repository changed; reverify scoped access',status=CASE WHEN status IN ('revoked','expired') THEN status ELSE 'needs_approval' END,updated_at=now() WHERE project_id=NEW.id AND capability='github_actions_read';
 END IF;
 RETURN NEW;
END;
$f$$s$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'repository_resync_bound_work' AND NOT tgisinternal) THEN
    EXECUTE 'CREATE TRIGGER repository_resync_bound_work BEFORE UPDATE OF github_repo ON public.owner_projects FOR EACH ROW EXECUTE FUNCTION public.guard_repository_resync_target()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'repository_resync_actions_access' AND NOT tgisinternal) THEN
    EXECUTE 'CREATE TRIGGER repository_resync_actions_access AFTER UPDATE OF github_repo ON public.owner_projects FOR EACH ROW EXECUTE FUNCTION public.reset_resynced_repo_access()';
  END IF;
END
$baseline_b$;

DO $baseline_c$
BEGIN
  IF to_regprocedure('public.apply_repository_resync_internal(uuid,uuid,jsonb)') IS NULL THEN
    EXECUTE $s$CREATE FUNCTION public.apply_repository_resync_internal(review_id uuid, actor_id uuid, changes jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$
BEGIN
 RAISE EXCEPTION 'apply_repository_resync_internal placeholder: superseded by 0031_repository_resync_drift_removals';
END;
$f$$s$;
    EXECUTE 'REVOKE ALL ON FUNCTION public.apply_repository_resync_internal(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regprocedure('public.apply_repository_resync(uuid,uuid,jsonb)') IS NULL THEN
    EXECUTE $s$CREATE FUNCTION public.apply_repository_resync(review_id uuid, actor_id uuid, changes jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $f$
BEGIN
 PERFORM set_config('jackboy.repository_resync','on',true);
 RETURN public.apply_repository_resync_internal(review_id,actor_id,changes);
END;
$f$$s$;
    EXECUTE 'REVOKE ALL ON FUNCTION public.apply_repository_resync(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.apply_repository_resync(uuid,uuid,jsonb) TO service_role';
  END IF;
END
$baseline_c$;

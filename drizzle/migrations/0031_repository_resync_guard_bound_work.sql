CREATE FUNCTION public.guard_repository_resync_target() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NEW.github_repo IS DISTINCT FROM OLD.github_repo AND EXISTS(SELECT 1 FROM public.repository_resync_reviews WHERE approved_at IS NULL AND requested_by IN (SELECT user_id FROM public.user_roles WHERE role='owner')) THEN
 IF EXISTS(SELECT 1 FROM public.update_proposals WHERE project_id=OLD.id AND status NOT IN ('rejected','merged','reverted')) OR EXISTS(SELECT 1 FROM public.foundry_tasks WHERE project_id=OLD.id AND state NOT IN ('completed','failed','rolled_back','rejected') AND (branch IS NOT NULL OR commit_sha IS NOT NULL OR pr_number IS NOT NULL OR approved_action IS NOT NULL OR state NOT IN ('discovered','blocked'))) OR EXISTS(SELECT 1 FROM public.omni_jobs WHERE project_id=OLD.id AND (status IN ('sent','running') OR (status='queued' AND code_request_id IS NOT NULL))) OR EXISTS(SELECT 1 FROM public.action_requests WHERE project_id=OLD.id AND status IN ('pending','approved','executing')) THEN
 RAISE EXCEPTION 'Repository has approval-bound or running work. Resolve that work before replacing the target.';
 END IF;
 NEW.connect_state:='not_connected'; NEW.connect_error:='Repository changed by owner; reconnect required'; NEW.connect_pr_url:=NULL;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER repository_resync_bound_work BEFORE UPDATE OF github_repo ON public.owner_projects FOR EACH ROW EXECUTE FUNCTION public.guard_repository_resync_target();
CREATE FUNCTION public.reset_resynced_repo_access() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NEW.github_repo IS DISTINCT FROM OLD.github_repo THEN
 UPDATE public.capability_grants SET last_verified_at=NULL,last_error='Repository changed; reverify scoped access',status=CASE WHEN status IN ('revoked','expired') THEN status ELSE 'needs_approval' END,updated_at=now() WHERE project_id=NEW.id AND capability='github_actions_read';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER repository_resync_actions_access AFTER UPDATE OF github_repo ON public.owner_projects FOR EACH ROW EXECUTE FUNCTION public.reset_resynced_repo_access();
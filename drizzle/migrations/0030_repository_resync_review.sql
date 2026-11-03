CREATE TABLE public.repository_resync_reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requested_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes', inventory jsonb NOT NULL, references_snapshot jsonb NOT NULL, approved_at timestamptz, replacements jsonb);
GRANT SELECT ON public.repository_resync_reviews TO authenticated;
GRANT ALL ON public.repository_resync_reviews TO service_role;
ALTER TABLE public.repository_resync_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_review_read ON public.repository_resync_reviews FOR SELECT TO authenticated USING (requested_by=auth.uid() AND public.my_role()='owner');
CREATE FUNCTION public.repository_reference_inventory() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT coalesce(jsonb_agg(r),'[]'::jsonb) FROM (
 SELECT 'owner_projects' AS "table", id::text, 'github_repo' AS field, github_repo AS value, true AS mutable FROM public.owner_projects WHERE github_repo IS NOT NULL
 UNION ALL SELECT 'agent_projects', id::text, 'repo_url', repo_url, true FROM public.agent_projects WHERE repo_url IS NOT NULL
 UNION ALL SELECT 'foundry_tasks', id::text, 'repo', repo, state IN ('discovered','blocked') AND branch IS NULL AND commit_sha IS NULL AND pr_number IS NULL AND approved_action IS NULL FROM public.foundry_tasks WHERE repo IS NOT NULL
 UNION ALL SELECT 'omni_jobs', id::text, 'repo', repo, status='queued' AND sent_at IS NULL AND code_request_id IS NULL FROM public.omni_jobs WHERE repo IS NOT NULL
 UNION ALL SELECT 'action_requests', id::text, 'resources.repo', resources->>'repo', false FROM public.action_requests WHERE resources->>'repo' IS NOT NULL
 UNION ALL SELECT 'site_log', id::text, 'repo', repo, false FROM public.site_log WHERE repo IS NOT NULL
 UNION ALL SELECT 'agent_memory', id::text, 'repo', repo, false FROM public.agent_memory WHERE repo IS NOT NULL
 ) r;
$$;
REVOKE ALL ON FUNCTION public.repository_reference_inventory() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repository_reference_inventory() TO service_role;
CREATE FUNCTION public.apply_repository_resync(review_id uuid, actor_id uuid, changes jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE review public.repository_resync_reviews; item jsonb; ref jsonb; old_repo text; new_repo text; changed int:=0; n int; pid uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=actor_id AND role='owner') THEN RAISE EXCEPTION 'Owner only'; END IF;
 SELECT * INTO review FROM public.repository_resync_reviews WHERE id=review_id AND requested_by=actor_id FOR UPDATE;
 IF NOT FOUND OR review.expires_at<=now() THEN RAISE EXCEPTION 'Review expired. Resync again.'; END IF;
 IF review.approved_at IS NOT NULL THEN RETURN jsonb_build_object('fixed',review.replacements,'alreadyApplied',true); END IF;
 IF jsonb_typeof(changes)<>'array' OR jsonb_array_length(changes)=0 OR jsonb_array_length(changes)>100 THEN RAISE EXCEPTION 'Select 1 to 100 replacements'; END IF;
 LOCK TABLE public.owner_projects,public.agent_projects,public.foundry_tasks,public.omni_jobs IN SHARE ROW EXCLUSIVE MODE;
 FOR item IN SELECT * FROM jsonb_array_elements(changes) LOOP
 old_repo:=item->>'from'; new_repo:=item->>'to';
 IF old_repo IS NULL OR new_repo IS NULL OR old_repo=new_repo OR NOT review.inventory @> jsonb_build_array(new_repo) THEN RAISE EXCEPTION 'Replacement is not in verified token inventory'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(changes) c WHERE lower(c->>'from')=lower(old_repo))<>1 THEN RAISE EXCEPTION 'Duplicate replacement'; END IF;
 IF review.inventory @> jsonb_build_array(old_repo) THEN RAISE EXCEPTION 'Repository is already linked'; END IF;
 -- Reject stale/new mutable references before any update. All errors roll back the entire approval.
 IF (SELECT coalesce(jsonb_agg(x ORDER BY x->>'table',x->>'id'),'[]'::jsonb) FROM jsonb_array_elements(public.repository_reference_inventory()) x WHERE x->>'mutable'='true' AND lower(regexp_replace(regexp_replace(x->>'value','^https://github.com/','','i'),'[.]git/?$','','i'))=lower(old_repo)) IS DISTINCT FROM
 (SELECT coalesce(jsonb_agg(x ORDER BY x->>'table',x->>'id'),'[]'::jsonb) FROM jsonb_array_elements(review.references_snapshot) x WHERE x->>'mutable'='true' AND lower(regexp_replace(regexp_replace(x->>'value','^https://github.com/','','i'),'[.]git/?$','','i'))=lower(old_repo)) THEN RAISE EXCEPTION 'Saved references changed. Resync again.'; END IF;
 n:=0;
 FOR ref IN SELECT * FROM jsonb_array_elements(review.references_snapshot) x WHERE x->>'mutable'='true' AND lower(regexp_replace(regexp_replace(x->>'value','^https://github.com/','','i'),'[.]git/?$','','i'))=lower(old_repo) LOOP
 CASE ref->>'table'
 WHEN 'owner_projects' THEN
 pid:=(ref->>'id')::uuid;
 UPDATE public.owner_projects SET github_repo=new_repo,dev_enabled=false,updated_at=now() WHERE id=pid AND github_repo=ref->>'value';
 UPDATE public.capability_grants SET last_verified_at=NULL,last_error='Repository changed by owner. Reverify access before resuming.',status=CASE WHEN status IN ('revoked','expired') THEN status ELSE 'needs_approval' END,updated_at=now() WHERE project_id=pid AND capability IN ('github_repo','github_actions');
 WHEN 'agent_projects' THEN UPDATE public.agent_projects SET repo_url=CASE WHEN ref->>'value' LIKE 'https://github.com/%' THEN 'https://github.com/'||new_repo ELSE new_repo END WHERE id=(ref->>'id')::uuid AND repo_url=ref->>'value';
 WHEN 'foundry_tasks' THEN UPDATE public.foundry_tasks SET repo=new_repo,paused=true,blocked_reason='Repository changed by owner; reverify and review before resuming',updated_at=now() WHERE id=(ref->>'id')::uuid AND repo=ref->>'value';
 WHEN 'omni_jobs' THEN UPDATE public.omni_jobs SET repo=new_repo,status='cancelled',last_error='Repository changed by owner; request a new approved job' WHERE id=(ref->>'id')::uuid AND repo=ref->>'value';
 ELSE RAISE EXCEPTION 'Unsupported mutable reference'; END CASE;
 n:=n+1;
 END LOOP;
 IF n=0 THEN RAISE EXCEPTION 'No mutable references for repository'; END IF;
 changed:=changed+n;
 END LOOP;
 UPDATE public.repository_resync_reviews SET approved_at=now(),replacements=changes WHERE id=review_id;
 INSERT INTO public.audit_logs(actor,action,outcome,detail) VALUES(actor_id,'repositories.resync.approved','ok',jsonb_build_object('review',review_id,'replacements',changes,'references',changed));
 INSERT INTO public.site_log(actor,action,category,status,summary,detail) VALUES('owner:'||actor_id,'repositories.resync.approved','config','ok','Owner-approved repository replacements applied; previous history preserved',jsonb_build_object('review',review_id,'replacements',changes,'references',changed));
 RETURN jsonb_build_object('fixed',changes,'references',changed,'alreadyApplied',false);
END;
$$;
REVOKE ALL ON FUNCTION public.apply_repository_resync(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_repository_resync(uuid,uuid,jsonb) TO service_role;
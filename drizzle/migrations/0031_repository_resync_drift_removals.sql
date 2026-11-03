ALTER TABLE public.repository_resync_reviews ADD COLUMN IF NOT EXISTS report jsonb, ADD COLUMN IF NOT EXISTS invalidated boolean NOT NULL DEFAULT false;
CREATE OR REPLACE FUNCTION public.apply_repository_resync_internal(review_id uuid, actor_id uuid, changes jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE review public.repository_resync_reviews; item jsonb; ref jsonb; old_repo text; new_repo text; changed int:=0; n int; pid uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=actor_id AND role='owner') THEN RAISE EXCEPTION 'Owner only'; END IF;
 SELECT * INTO review FROM public.repository_resync_reviews WHERE id=review_id AND requested_by=actor_id FOR UPDATE;
 IF NOT FOUND OR review.expires_at<=now() OR review.invalidated THEN RAISE EXCEPTION 'Review expired or invalidated. Resync again.'; END IF;
 IF review.approved_at IS NOT NULL THEN RETURN jsonb_build_object('fixed',review.replacements,'alreadyApplied',true); END IF;
 IF jsonb_typeof(changes)<>'array' OR jsonb_array_length(changes)=0 OR jsonb_array_length(changes)>100 THEN RAISE EXCEPTION 'Select 1 to 100 changes'; END IF;
 LOCK TABLE public.owner_projects,public.agent_projects,public.foundry_tasks,public.omni_jobs IN SHARE ROW EXCLUSIVE MODE;
 FOR item IN SELECT * FROM jsonb_array_elements(changes) LOOP
 old_repo:=item->>'from'; new_repo:=item->>'to';
 IF old_repo IS NULL OR old_repo=new_repo THEN RAISE EXCEPTION 'Invalid repository change'; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(review.report->'rows') x WHERE x->>'repo'=old_repo AND x->>'canApply'='true' AND (x->>'proposed') IS NOT DISTINCT FROM new_repo) THEN RAISE EXCEPTION 'Change is not in verified review'; END IF;
 IF new_repo IS NOT NULL AND NOT review.inventory @> jsonb_build_array(new_repo) THEN RAISE EXCEPTION 'Replacement is not in verified token inventory'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(changes) c WHERE lower(c->>'from')=lower(old_repo))<>1 THEN RAISE EXCEPTION 'Duplicate replacement'; END IF;
 IF (SELECT coalesce(jsonb_agg(x ORDER BY x->>'table',x->>'id'),'[]'::jsonb) FROM jsonb_array_elements(public.repository_reference_inventory()) x WHERE x->>'mutable'='true' AND lower(regexp_replace(regexp_replace(x->>'value','^https://github.com/','','i'),'[.]git/?$','','i'))=lower(old_repo)) IS DISTINCT FROM (SELECT coalesce(jsonb_agg(x ORDER BY x->>'table',x->>'id'),'[]'::jsonb) FROM jsonb_array_elements(review.references_snapshot) x WHERE x->>'mutable'='true' AND lower(regexp_replace(regexp_replace(x->>'value','^https://github.com/','','i'),'[.]git/?$','','i'))=lower(old_repo)) THEN RAISE EXCEPTION 'Saved references changed. Resync again.'; END IF;
 n:=0;
 FOR ref IN SELECT * FROM jsonb_array_elements(review.references_snapshot) x WHERE x->>'mutable'='true' AND lower(regexp_replace(regexp_replace(x->>'value','^https://github.com/','','i'),'[.]git/?$','','i'))=lower(old_repo) LOOP
 CASE ref->>'table'
 WHEN 'owner_projects' THEN
 pid:=(ref->>'id')::uuid;
 UPDATE public.owner_projects SET github_repo=new_repo,dev_enabled=false,updated_at=now() WHERE id=pid AND github_repo=ref->>'value';
 UPDATE public.capability_grants SET last_verified_at=NULL,last_error='Repository changed by owner. Reverify access before resuming.',status=CASE WHEN status IN ('revoked','expired') THEN status ELSE 'needs_approval' END,updated_at=now() WHERE project_id=pid AND capability IN ('github_repo','github_actions');
 WHEN 'agent_projects' THEN UPDATE public.agent_projects SET repo_url=CASE WHEN new_repo IS NULL THEN NULL WHEN ref->>'value' LIKE 'https://github.com/%' THEN 'https://github.com/'||new_repo ELSE new_repo END WHERE id=(ref->>'id')::uuid AND repo_url=ref->>'value';
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
 INSERT INTO public.site_log(actor,action,category,status,summary,detail) VALUES('owner:'||actor_id,'repositories.resync.approved','config','ok','Owner-approved repository changes applied; project records and history preserved',jsonb_build_object('review',review_id,'replacements',changes,'references',changed));
 RETURN jsonb_build_object('fixed',changes,'references',changed,'alreadyApplied',false);
END; $$;
REVOKE ALL ON FUNCTION public.apply_repository_resync_internal(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.apply_project_repository_resync(review_id uuid,actor_id uuid,changes jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE review public.repository_resync_reviews; item jsonb; row_json jsonb; profile jsonb; a jsonb; standard_changes jsonb:='[]'; pid uuid; affected int; result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=actor_id AND role='owner') THEN RAISE EXCEPTION 'Owner only'; END IF;
 SELECT * INTO review FROM public.repository_resync_reviews WHERE id=review_id AND requested_by=actor_id FOR UPDATE;
 IF NOT FOUND OR review.expires_at<=now() OR review.invalidated THEN RAISE EXCEPTION 'Review expired or invalidated'; END IF;
 IF review.approved_at IS NOT NULL THEN RETURN jsonb_build_object('alreadyApplied',true); END IF;
 IF jsonb_typeof(changes)<>'array' OR jsonb_array_length(changes)=0 OR jsonb_array_length(changes)>100 THEN RAISE EXCEPTION 'Select 1 to 100 changes'; END IF;
 LOCK TABLE public.owner_projects,public.agent_projects,public.foundry_tasks,public.omni_jobs IN SHARE ROW EXCLUSIVE MODE;
 PERFORM set_config('jackboy.repository_resync','on',true);
 FOR item IN SELECT * FROM jsonb_array_elements(changes) LOOP
  SELECT x INTO row_json FROM jsonb_array_elements(review.report->'rows') x WHERE x->>'repo'=item->>'from' AND x->>'canApply'='true' AND (x->>'proposed') IS NOT DISTINCT FROM (item->>'to');
  IF NOT FOUND OR coalesce(item->'profiles','[]') IS DISTINCT FROM coalesce(row_json->'profiles','[]') THEN RAISE EXCEPTION 'Change not in verified review'; END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(changes) c WHERE c->>'from'=item->>'from')<>1 THEN RAISE EXCEPTION 'Duplicate change'; END IF;
  IF item->>'to' IS NOT NULL AND NOT review.inventory @> jsonb_build_array(item->>'to') THEN RAISE EXCEPTION 'Replacement outside token inventory'; END IF;
  FOR profile IN SELECT * FROM jsonb_array_elements(coalesce(row_json->'profiles','[]')) LOOP
   pid:=(profile->>'projectId')::uuid;
   IF NOT EXISTS(SELECT 1 FROM public.owner_projects WHERE id=pid AND name=profile->>'oldName' AND github_repo IS NOT DISTINCT FROM (profile->>'oldRepo')) THEN RAISE EXCEPTION 'Project profile changed; resync again'; END IF;
   FOR a IN SELECT * FROM jsonb_array_elements(coalesce(profile->'agentProfiles','[]')) LOOP
    IF NOT EXISTS(SELECT 1 FROM public.agent_projects WHERE id=(a->>'id')::uuid AND name=a->>'name' AND repo_url IS NOT DISTINCT FROM (a->>'repo_url')) THEN RAISE EXCEPTION 'Inventory profile changed; resync again'; END IF;
   END LOOP;
  END LOOP;
  IF row_json->>'group'='missing' THEN
   IF item->>'to' IS NULL OR jsonb_array_length(row_json->'profiles')<>1 THEN RAISE EXCEPTION 'Missing unique match'; END IF;
   profile:=row_json->'profiles'->0; pid:=(profile->>'projectId')::uuid;
   IF profile->>'oldRepo' IS NOT NULL THEN RAISE EXCEPTION 'Not a missing link'; END IF;
   UPDATE public.owner_projects SET github_repo=item->>'to',dev_enabled=false,updated_at=now() WHERE id=pid AND github_repo IS NULL;
   GET DIAGNOSTICS affected=ROW_COUNT; IF affected<>1 THEN RAISE EXCEPTION 'Missing profile changed'; END IF;
   UPDATE public.capability_grants SET last_verified_at=NULL,last_error='Repository linked by owner; verify scoped access',status=CASE WHEN status IN ('revoked','expired') THEN status ELSE 'needs_approval' END,updated_at=now() WHERE project_id=pid AND capability='github_repo';
  ELSE standard_changes:=standard_changes||jsonb_build_array(jsonb_build_object('from',item->>'from','to',item->>'to')); END IF;
 END LOOP;
 IF jsonb_array_length(standard_changes)>0 THEN result:=public.apply_repository_resync_internal(review_id,actor_id,standard_changes); END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(changes) LOOP
  FOR profile IN SELECT * FROM jsonb_array_elements(coalesce(item->'profiles','[]')) LOOP
   UPDATE public.owner_projects SET name=profile->>'newName',updated_at=now() WHERE id=(profile->>'projectId')::uuid;
   FOR a IN SELECT * FROM jsonb_array_elements(coalesce(profile->'agentProfiles','[]')) LOOP
    UPDATE public.agent_projects SET name=profile->>'newName',repo_url='https://github.com/'||(item->>'to') WHERE id=(a->>'id')::uuid;
   END LOOP;
  END LOOP;
 END LOOP;
 UPDATE public.repository_resync_reviews SET approved_at=now(),replacements=changes WHERE id=review_id;
 INSERT INTO public.audit_logs(actor,action,outcome,detail) VALUES(actor_id,'projects.resync.approved','ok',jsonb_build_object('review',review_id,'changes',changes));
 INSERT INTO public.site_log(actor,action,category,status,summary,detail) VALUES('owner:'||actor_id,'projects.resync.approved','config','ok','Owner-approved links and current profile names updated atomically; history preserved',jsonb_build_object('review',review_id,'changes',changes));
 RETURN jsonb_build_object('alreadyApplied',false,'changes',changes);
END $$;
REVOKE ALL ON FUNCTION public.apply_project_repository_resync(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.apply_project_repository_resync(uuid,uuid,jsonb) TO service_role;
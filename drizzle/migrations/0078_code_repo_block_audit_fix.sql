CREATE OR REPLACE FUNCTION public.set_code_repo_block(p_actor uuid, p_repo text, p_blocked boolean, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
  IF p_actor IS NULL OR NOT public.has_role(p_actor, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only the owner can change the CODE block list.' USING ERRCODE = '42501';
  END IF;
  IF p_repo IS NULL OR p_repo !~ '^OMERTA-ROW/[A-Za-z0-9._-]{1,100}$' THEN
    RAISE EXCEPTION 'Invalid repository.' USING ERRCODE = '22023';
  END IF;
  IF p_blocked THEN
    INSERT INTO public.code_repo_blocklist(repo, reason, blocked_by)
    VALUES (p_repo, left(coalesce(p_reason, ''), 300), p_actor)
    ON CONFLICT (repo) DO UPDATE SET reason = excluded.reason, blocked_by = excluded.blocked_by, created_at = now();
  ELSE
    DELETE FROM public.code_repo_blocklist WHERE repo = p_repo;
  END IF;
  INSERT INTO public.audit_logs(actor, action, detail, outcome)
  VALUES (p_actor, CASE WHEN p_blocked THEN 'code.repo_blocked' ELSE 'code.repo_unblocked' END,
          jsonb_build_object('repo', p_repo), 'allowed');
END $$;
REVOKE ALL ON FUNCTION public.set_code_repo_block(uuid, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_code_repo_block(uuid, text, boolean, text) TO service_role;
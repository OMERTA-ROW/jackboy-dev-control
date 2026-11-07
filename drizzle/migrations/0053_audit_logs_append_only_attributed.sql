-- Older audit list becomes append-only. Existing rows are kept untouched.
CREATE OR REPLACE FUNCTION public.audit_logs_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'Audit log is append-only: entries cannot be changed or deleted';
END $$;

DROP TRIGGER IF EXISTS audit_logs_no_update_delete ON public.audit_logs;
CREATE TRIGGER audit_logs_no_update_delete
  BEFORE UPDATE OR DELETE ON public.audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.audit_logs_immutable();

DROP TRIGGER IF EXISTS audit_logs_no_truncate ON public.audit_logs;
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON public.audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_logs_immutable();

-- Signed-in users may only read (RLS still limits rows). Writes stay on the server path.
REVOKE ALL ON public.audit_logs FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.audit_logs FROM authenticated;
GRANT SELECT ON public.audit_logs TO authenticated;
REVOKE UPDATE, DELETE, TRUNCATE ON public.audit_logs FROM service_role;
GRANT SELECT, INSERT ON public.audit_logs TO service_role;

-- Attributed read: who did each action (role, and email for managers or the actor themself).
CREATE OR REPLACE FUNCTION public.audit_log_attributed(_limit integer DEFAULT 50, _before timestamptz DEFAULT NULL)
RETURNS TABLE(id uuid, at timestamptz, actor uuid, actor_role public.app_role, actor_email text, action text, outcome text, detail jsonb)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT a.id, a.at, a.actor, r.role,
         CASE WHEN a.actor IS NOT NULL AND (a.actor = auth.uid() OR public.is_manager(auth.uid()))
              THEN u.email::text END,
         a.action, a.outcome, a.detail
  FROM public.audit_logs a
  LEFT JOIN LATERAL (
    SELECT ur.role FROM public.user_roles ur WHERE ur.user_id = a.actor ORDER BY ur.created_at LIMIT 1
  ) r ON true
  LEFT JOIN auth.users u ON u.id = a.actor
  WHERE auth.uid() IS NOT NULL
    AND (a.actor = auth.uid() OR public.is_manager(auth.uid()))
    AND (_before IS NULL OR a.at < _before)
  ORDER BY a.at DESC
  LIMIT LEAST(GREATEST(COALESCE(_limit, 50), 1), 200)
$$;

REVOKE ALL ON FUNCTION public.audit_log_attributed(integer, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_log_attributed(integer, timestamptz) TO authenticated;

COMMENT ON TABLE public.audit_logs IS 'Append-only: triggers reject UPDATE/DELETE/TRUNCATE. Read attributed rows via audit_log_attributed().';
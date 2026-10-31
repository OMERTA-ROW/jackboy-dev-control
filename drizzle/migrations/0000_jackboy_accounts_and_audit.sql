CREATE TYPE public.app_role AS ENUM ('owner', 'admin', 'member');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);
CREATE UNIQUE INDEX one_owner ON public.user_roles ((role)) WHERE role = 'owner';
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;
CREATE OR REPLACE FUNCTION public.my_role()
RETURNS public.app_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM public.user_roles WHERE user_id = auth.uid()
$$;
CREATE OR REPLACE FUNCTION public.is_manager(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role IN ('owner','admin'))
$$;

CREATE POLICY "own role or managers read" ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_manager(auth.uid()));

CREATE TABLE public.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  role public.app_role NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'pending',
  invited_by uuid NOT NULL,
  accepted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  CONSTRAINT invite_role_not_owner CHECK (role <> 'owner'),
  CONSTRAINT invite_status CHECK (status IN ('pending','accepted','revoked'))
);
GRANT SELECT ON public.invitations TO authenticated;
GRANT ALL ON public.invitations TO service_role;
ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "managers read invitations" ON public.invitations FOR SELECT TO authenticated
  USING (public.is_manager(auth.uid()));

CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  actor uuid,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome text NOT NULL DEFAULT 'ok'
);
CREATE INDEX audit_actor_action_at ON public.audit_logs (actor, action, at DESC);
GRANT SELECT ON public.audit_logs TO authenticated;
GRANT ALL ON public.audit_logs TO service_role;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "managers read all, members own" ON public.audit_logs FOR SELECT TO authenticated
  USING (actor = auth.uid() OR public.is_manager(auth.uid()));

CREATE OR REPLACE FUNCTION public.write_audit(_action text, _detail jsonb, _outcome text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.audit_logs(actor, action, detail, outcome) VALUES (auth.uid(), _action, coalesce(_detail,'{}'::jsonb), coalesce(_outcome,'ok'));
END $$;

CREATE OR REPLACE FUNCTION public.create_invitation(_email text, _role public.app_role)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _id uuid; _norm text := lower(trim(_email));
BEGIN
  IF _role = 'owner' THEN RAISE EXCEPTION 'Owner role cannot be invited'; END IF;
  IF _role = 'admin' AND NOT public.has_role(auth.uid(),'owner') THEN RAISE EXCEPTION 'Only the owner can invite admins'; END IF;
  IF NOT public.is_manager(auth.uid()) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  IF _norm !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RAISE EXCEPTION 'Invalid email'; END IF;
  UPDATE public.invitations SET status='revoked' WHERE email=_norm AND status='pending';
  INSERT INTO public.invitations(email, role, invited_by) VALUES (_norm, _role, auth.uid()) RETURNING id INTO _id;
  PERFORM public.write_audit('invite.create', jsonb_build_object('email',_norm,'role',_role), 'ok');
  RETURN _id;
END $$;

CREATE OR REPLACE FUNCTION public.revoke_invitation(_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_manager(auth.uid()) THEN RAISE EXCEPTION 'Not allowed'; END IF;
  UPDATE public.invitations SET status='revoked' WHERE id=_id AND status='pending';
  PERFORM public.write_audit('invite.revoke', jsonb_build_object('id',_id), 'ok');
END $$;

CREATE OR REPLACE FUNCTION public.accept_invitation()
RETURNS public.app_role LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _inv public.invitations; _email text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
  SELECT lower(email) INTO _email FROM auth.users WHERE id = auth.uid() AND email_confirmed_at IS NOT NULL;
  IF _email IS NULL THEN RAISE EXCEPTION 'Confirm your email first'; END IF;
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid()) THEN
    RETURN (SELECT role FROM public.user_roles WHERE user_id = auth.uid());
  END IF;
  SELECT * INTO _inv FROM public.invitations WHERE email=_email AND status='pending' AND expires_at > now() ORDER BY created_at DESC LIMIT 1;
  IF _inv.id IS NULL THEN
    PERFORM public.write_audit('invite.accept', jsonb_build_object('email',_email), 'denied');
    RAISE EXCEPTION 'No valid invitation for this email';
  END IF;
  INSERT INTO public.user_roles(user_id, role) VALUES (auth.uid(), _inv.role);
  UPDATE public.invitations SET status='accepted', accepted_by=auth.uid() WHERE id=_inv.id;
  PERFORM public.write_audit('invite.accept', jsonb_build_object('email',_email,'role',_inv.role), 'ok');
  RETURN _inv.role;
END $$;

CREATE OR REPLACE FUNCTION public.remove_member(_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_role(auth.uid(),'owner') THEN RAISE EXCEPTION 'Only the owner can remove access'; END IF;
  IF public.has_role(_user_id,'owner') THEN RAISE EXCEPTION 'Owner access cannot be removed'; END IF;
  DELETE FROM public.user_roles WHERE user_id=_user_id;
  PERFORM public.write_audit('member.remove', jsonb_build_object('user_id',_user_id), 'ok');
END $$;

REVOKE EXECUTE ON FUNCTION public.write_audit(text,jsonb,text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.create_invitation(text,public.app_role) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.revoke_invitation(uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.accept_invitation() FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.remove_member(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.write_audit(text,jsonb,text), public.create_invitation(text,public.app_role), public.revoke_invitation(uuid), public.accept_invitation(), public.remove_member(uuid), public.my_role(), public.has_role(uuid,public.app_role), public.is_manager(uuid) TO authenticated;
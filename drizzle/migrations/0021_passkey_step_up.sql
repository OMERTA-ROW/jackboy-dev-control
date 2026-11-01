CREATE TABLE public.owner_passkeys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  credential_id text NOT NULL UNIQUE,
  public_key text NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  label text NOT NULL DEFAULT 'Passkey',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
GRANT SELECT ON public.owner_passkeys TO authenticated;
GRANT ALL ON public.owner_passkeys TO service_role;
ALTER TABLE public.owner_passkeys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner reads own passkeys" ON public.owner_passkeys FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE TABLE public.webauthn_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  challenge text NOT NULL,
  purpose text NOT NULL,
  action text,
  target text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.webauthn_challenges TO service_role;
ALTER TABLE public.webauthn_challenges ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.step_up_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  credential_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.step_up_grants TO authenticated;
GRANT ALL ON public.step_up_grants TO service_role;
ALTER TABLE public.step_up_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Owner reads own step-up grants" ON public.step_up_grants FOR SELECT TO authenticated USING (user_id = auth.uid());
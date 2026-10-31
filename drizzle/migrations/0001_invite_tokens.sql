ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS token_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_hash ON public.invitations (token_hash) WHERE token_hash IS NOT NULL;
ALTER TABLE public.invitations ADD COLUMN IF NOT EXISTS used_at timestamptz;
REVOKE EXECUTE ON FUNCTION public.accept_invitation() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.create_invitation(text, public.app_role) FROM authenticated;
COMMENT ON FUNCTION public.accept_invitation() IS 'DEPRECATED: replaced by single-use token redemption server function';
COMMENT ON FUNCTION public.create_invitation(text, public.app_role) IS 'DEPRECATED: invitations are created by server function with hashed tokens';
-- Signed-out visitors get no access; records are archived, never deleted.
REVOKE ALL ON public.omni_research_handoffs FROM anon;
REVOKE ALL ON public.jax_release_manifests FROM anon;
REVOKE DELETE, TRUNCATE ON public.omni_research_handoffs FROM authenticated;
REVOKE DELETE, TRUNCATE ON public.jax_release_manifests FROM authenticated;
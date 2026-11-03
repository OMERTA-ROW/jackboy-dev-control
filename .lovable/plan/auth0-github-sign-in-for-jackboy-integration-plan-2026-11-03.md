# Auth0 (GitHub) sign-in for Jackboy — integration plan

## Answer
Yes. Jackboy's sign-in service (Lovable Cloud) supports exactly one company-login (OIDC) provider. Auth0 can be that provider, so GitHub sign-in can be added **alongside** the owner account, email/password, Google and Microsoft. Nothing is replaced. The GitHub App used for repo work is a separate system and is not affected.

## Current state (checked)
- Sign-in page shows email/password, Google and Microsoft (managed Lovable sign-in); GitHub shows "Not available".
- No company-login provider is set up yet. Open sign-up is off; roles come only from the owner claim or invitations.
- A setup guide is already in Files: jackboy-github-signin-auth0-guide.md.

## Owner setup (you do this; no secrets in chat)
1. In Auth0 (omerta-row.us.auth0.com) create a **Regular Web Application** for Jackboy, enable only the GitHub connection on it, and require verified email.
2. Allowed Callback URL in Auth0: `https://hjrpqygyaluaurrzbqry.supabase.co/auth/v1/callback`. I'll re-confirm the exact address before you save it.
3. Allowed Web Origins / Logout URLs: `https://jackboy-dev-control.lovable.app` and the preview address.
4. In Lovable: More → Users → Auth settings → OIDC. Enter issuer `https://omerta-row.us.auth0.com/`, Client ID, Client Secret, scopes `openid email profile`.
5. Tell me "OIDC is saved".

## What I build after approval
- Turn the GitHub button on so it starts Auth0 sign-in and returns to `/auth`. It shows only once the provider is set up.
- A GitHub/Auth0 sign-in gets **no role**. With no invitation, the user ends up on the no-access screen.
- Owner linking: you can link GitHub/Auth0 to the owner account only while signed in with your existing method and after a passkey check. No automatic linking by matching email, which blocks takeover through a lookalike GitHub email.
- Account → Security lists linked sign-in methods. Unlinking needs a passkey, and the last remaining method can't be removed.
- A recovery log entry and email go out whenever a sign-in method is linked or unlinked.

## Constraints and risks
- Only one OIDC slot. Using it for Auth0 means Okta and similar services can't be added directly later (Auth0 can still pass several providers through to Jackboy).
- Auth0 becomes a dependency. If Auth0 is down, GitHub sign-in fails, but email, Google, Microsoft and passkey keep working.
- If Auth0 sends an unverified email, sign-in is refused.

## Alternatives (not recommended)
- Moving Jackboy to a different sign-in service with built-in GitHub means moving every account and session, with high risk to owner access.
- Using the GitHub App for sign-in isn't suitable. It grants repo access, not login identity.

## Testing (preview, before any publish)
- Owner email/password, Google and Microsoft still sign in, and owner role is recognized.
- A new GitHub/Auth0 user signs in and gets no role or private pages.
- Owner links GitHub with a passkey, signs out, signs back in with GitHub, and is recognized as owner.
- Abuse paths: linking without a passkey is refused; an unverified email is refused; removing the last method is blocked.
- Signed-out visitors are still redirected away from private pages. Typecheck and existing tests pass.

## Technical notes
- Call `supabase.auth.signInWithOAuth({ provider: "custom:app-oidc", options: { redirectTo: origin + "/auth" } })`.
- Link with `supabase.auth.linkIdentity` behind the existing passkey grant (action `link_identity`). Read identities with `getUserIdentities`.
- No database changes required. Nothing is published.

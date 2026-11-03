# Jackboy sign-in: what's actually configured (read-only findings)

## Verified this turn
- **Backend: Lovable Cloud.** The project config and app settings both point to the single Lovable Cloud backend that serves preview and the published app. Nothing in the code points to a separate, user-owned Supabase project. If you have a Supabase connection somewhere else, this app isn't using it.
- **Sign-in options switched on right now:** only email and password. Open sign-up is **off** (invitation/owner only). Google, Microsoft and GitHub are all **off**.
- **Sign-in page:** shows Google and Microsoft buttons only when the backend reports them enabled. GitHub is hard-coded as unsupported. No code anywhere calls a social sign-in yet, and the Lovable sign-in helper isn't installed.
- **Authenticator app (TOTP):** wired up using the backend's built-in support. Setup lives on Security, and the 6-digit code step runs at sign-in. The server doesn't yet require the code before private actions.

## Support and safe requirements per method
- **Google:** supported and managed by Lovable Cloud. You don't need your own Google keys and you don't register any return address. To turn it on: switch on the provider, which adds the official Lovable sign-in helper, then wire the button to that helper with the return address set to the site's own home page.
- **Microsoft:** supported and managed the same way as Google. Using your own Azure keys is optional. If you do, copy the return address shown under Users → Auth settings → Microsoft into Azure.
- **GitHub sign-in:** not supported by Lovable Cloud. This is separate from the GitHub App Jackboy uses for code access, which keeps working.
- **Own company identity provider (OIDC):** possible as an alternative. You enter its details in Auth settings, and that screen gives you the return addresses to register.
- **TOTP:** no outside setup needed. Recovery codes still need the pending database update (0039).

## Linking the owner account
- Owner status comes from your owner email and the roles table, never from a provider. Signing in with Google or Microsoft gives the same account only if that provider confirms the same email as your owner email.
- Lowest-risk order: sign in with email and password first, then add the provider. Also confirm that a Google sign-in can't create a new account while sign-up is off.

## Unknown / not checked
- Whether the managed Google/Microsoft redirect list already covers the published address. Lovable keeps this in sync automatically, but I haven't read the list.
- What your outside Supabase connection is used for, if anything.
- Whether email delivery works in production beyond the earlier test reset email.

## Next steps once approved (lowest risk first)
1. Turn on Google and Microsoft (managed). This changes only which sign-in options appear and touches no data.
2. Connect both buttons to the Lovable helper. Remove the GitHub button or label it "not available".
3. Test owner sign-in with Google in preview. Confirm the Account page shows Owner and that an unknown Google account is refused.
4. Optionally, require the authenticator code on the server for private actions, and approve the recovery-codes update (0039).

Nothing is changed until you approve.

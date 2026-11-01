<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Jackboy rules
- Owner identity configuration and mail delivery are separate states; auth helpers revalidate confirmed sign-in and propagate sender failures, so configuration gaps never become fake email success or owner access.
- All private pages live under `src/routes/_authenticated/` (client gate checks session + `my_role`, else `/onboarding`); server functions and RLS re-check roles. Owner bootstrap only via `claimOwner` matching the `OWNER_EMAIL` secret; others join only via `accept_invitation` RPC (email match). Roles live in `user_roles`.
- Internet research is server-only (`src/lib/research.functions.ts`, policy in `src/lib/search-policy.ts`): Brave key in `BRAVE_SEARCH_API_KEY` secret, domain allowlist, timeout, audit-log-based rate limits; never return fake results when unconfigured.
- Lovable Cloud is enabled for account infrastructure; existing browser-local demo stores remain demo-only until an explicit user-scoped storage migration, so enabling auth never makes old demo records shared private data.
- Layout/code changes are only proposed as suggestions and applied via `resolveSuggestion` after explicit approval, which writes to the log.
- Shared shell/navigation is `src/components/AppShell.tsx`, rendered from `__root.tsx`.
- Jackboy is the research/evaluation/idea-routing agent; OMNI is the build/test/deploy engine. Handoffs, monetization estimates and provenance live in `src/lib/omni-handoff.ts` + `src/routes/omni.tsx`; publish/pricing/sell stay locked by `canApprove` until the handoff is approved and provenance is cleared. Never show OMNI as connected without verification.

- Subdirectories have their own `AGENTS.md` (feature rules in `src/lib/AGENTS.md`); read it before changing files there.

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
- Per-project permission refresh stores live read results and provider-declared write grants separately for GITHUB_TOKEN and the actual App work credential; never prove write by launching jobs or auto-resuming work. Passkey removal atomically consumes an owner/device-scoped grant and invalidates unused grants from that credential.
- Repository drift is read-only evidence checked through GITHUB_TOKEN; batch relink/unlink uses an owner/passkey-bound review and atomic RPC, preserves immutable history and blocks running/approval-bound targets so resync cannot redirect existing work.
- Owner identity configuration and mail delivery are separate states; auth helpers revalidate confirmed sign-in and propagate sender failures, so configuration gaps never become fake email success or owner access.
- All private pages live under `src/routes/_authenticated/` (client gate checks session + `my_role`, else `/onboarding`); server functions and RLS re-check roles. Owner bootstrap only via `claimOwner` matching the `OWNER_EMAIL` secret; others join only via `accept_invitation` RPC (email match). Roles live in `user_roles`.
- Internet research is server-only (`src/lib/research.functions.ts`, policy in `src/lib/search-policy.ts`): Brave key in `BRAVE_SEARCH_API_KEY` secret, domain allowlist, timeout, audit-log-based rate limits; never return fake results when unconfigured.
- Lovable Cloud is enabled for account infrastructure; existing browser-local demo stores remain demo-only until an explicit user-scoped storage migration, so enabling auth never makes old demo records shared private data.
- Layout/code changes are only proposed as suggestions and applied via `resolveSuggestion` after explicit approval, which writes to the log.
- Shared shell is `src/components/AppShell.tsx` (from `__root.tsx`); main menu stays small (Home, Projects, Connect, Approvals, Chat, Settings) and every advanced page is listed on `/settings` so menus never duplicate.
- The Connect picker lists only stored inventory (`agent_projects.lovable_project_ref`) labelled as a snapshot; live Lovable discovery appears only after a real linked, tested connection.
- Jackboy is the research/evaluation/idea-routing agent; OMNI is the build/test/deploy engine. Handoffs, monetization estimates and provenance live in `src/lib/omni-handoff.ts` + `src/routes/omni.tsx`; publish/pricing/sell stay locked by `canApprove` until the handoff is approved and provenance is cleared. Never show OMNI as connected without verification.

- Subdirectories have their own `AGENTS.md` (feature rules in `src/lib/AGENTS.md`); read it before changing files there.
- Live voice runs through `src/lib/live-relay.server.ts` at `/api/live` (dispatched in `src/server.ts`, dev via `live-vite-plugin.ts`): owner session verified before any paid voice session, and legacy voice change tools stay blocked; opt-in CODE requests use scoped session-bound cards, while sensitive actions keep their passkey/provider-native path.
- Site monitoring lives in `src/lib/site-monitor*.ts` (DNS-over-HTTPS + one HTTPS GET, stored on owner_projects with backoff, 15-min cron at /api/public/jobs/site-monitor); reachability never implies coding access.


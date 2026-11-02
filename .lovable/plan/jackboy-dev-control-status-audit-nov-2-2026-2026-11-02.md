# Jackboy Dev Control — Status Audit (Nov 2, 2026)

Diagnostic only. No code was changed. Sources: current error logs, the list of configured secrets, a scan of the code for required settings, and test evidence recorded earlier in this project.

## 1. Working end to end (checked with a signed-in owner)
- Owner sign-in, invitation-only accounts, roles, and blocking of private pages for signed-out visitors.
- Projects hub: search, multi-select with Select All/Clear, selections that persist per user, batch actions limited to 2 at a time with per-project results.
- Site connectivity check: URL validation, DNS lookup, one HTTPS request, saved status/evidence and backoff. Real results: 2 sites healthy, 17 have no address saved.
- Website Scan button: a real fetch of the site's pages. The Honeycomb Terminal scan found 1 page and 0 findings. Projects with no address show "Add site address to scan."
- Approvals: correct pending count, idempotent approve/reject, sync across tabs, audit trail.
- Passkey step-up: one-time, 5-minute grants tied to one action. Tested only with a virtual authenticator.
- GitHub read access (personal token): repo reads on Jackboy, Terminal, Vault and Nano, plus temporary branch create/delete. Jackboy draft PRs #1–#4 were opened.
- Typed chat: the full-screen conversation answers from real data ("You have 19 projects") and survives a page reload.
- Site Log, Blocker Queue, Foundry state machine, Releases/updater APIs with signed manifests.

## 2. Broken, half-wired or blocked
- **OMNI code changes**: GitHub returns 403 "Resource not accessible by personal access token" when creating a branch on `OMERTA-ROW/Omni`. Cause: the OMERTA-ROW organization has not granted the token write access. The repo can be read but not written.
- **GitHub App flow** (`src/lib/github-app.server.ts`, `/api/public/github/setup`): the code exists but has never run. Cause: the `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_SLUG` secrets are missing, and no App is registered.
- **CI / GitHub Actions evidence**: Actions read returns 403. No test runner exists, so Foundry "tests" are limited to deterministic checks, not real test runs.
- **Code scan** (`src/lib/code-scan.ts`): it checks only a few patterns (debugger, eval, unsafe `_blank`, hardcoded secrets). No full scan → repair → package → PR cycle has been verified on any project.
- **Live voice** (`src/lib/live-relay.server.ts`, `LiveVoiceCall.tsx`): setup times out in the sandbox. No real call has ever completed, so it is unverified, not confirmed broken.
- **Webhook route** (`/api/public/foundry/*`): it rejects every request. Cause: the `FOUNDRY_WEBHOOK_SECRET` secret is missing.
- **Research** (`research.functions.ts`): it reports "not configured." Cause: the `BRAVE_SEARCH_API_KEY` secret is missing.
- **Scheduled jobs** (Foundry, site monitor, updates every hour or 15 minutes): these run only on the published app, and the current code is unpublished. Background work will not happen until it is published.
- **Honeycomb Terminal**: its own test suite has 4 routing test failures (22 of 24 files pass), and 3 files still contain demo wording. Vault has demo/sample text in 17 files. Both are reported only; nothing was changed.

## 3. Real vs mocked/simulated
| Area | Status |
|---|---|
| Typed chat + tools | Real (calls the same backend actions as the buttons) |
| Chat voice (dictation + ElevenLabs replies) | Real browser speech + ElevenLabs; tested in a browser, not on a real device |
| Live two-way voice | Code exists, but no call has ever been verified |
| Foundry voice tools | Real backend calls; spoken changes need confirmation; voice cannot connect repos, merge or deploy. No full spoken call has been verified |
| OAuth / GitHub App | Not active: missing settings, never installed. A personal token is used instead |
| Code Connect flow | Real permission probes; a passkey-confirmed Connect has never been completed |
| Site connectivity check | Real |
| Scan button | Real fetch of website pages; code scan is real but shallow |
| OMNI handoff | Records are stored, but nothing is sent: no `OMNI_API_URL`/`OMNI_API_KEY`, and the queued job's sent_at is still empty |
| Razul handoff | Messages are queued but never delivered: no `RAZUL_API_URL`/`RAZUL_API_KEY` |
| JAX | Simulated screen only, with no payments or ingest; marked as such |
| Guardian | Only a concept; no integration exists |

## 4. Missing secrets / settings
Read by the code but not set: `BRAVE_SEARCH_API_KEY`, `FOUNDRY_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`, `OMNI_API_URL`, `OMNI_API_KEY`, `RAZUL_API_URL`, `RAZUL_API_KEY`, `LOVABLE_ACCOUNT_API_KEY` (live Lovable project discovery; needs a Business plan), `PUBLIC_APP_ORIGIN` (optional; used to build callback links). The backend provides `SUPABASE_*` automatically.
Set but unused or duplicate: `HC_OWNER_EMAIL` (the code reads `OWNER_EMAIL`).
Backend tables: none are missing that the code needs. The project uses no backend functions on purpose (all server logic runs in the app itself).

## 5. Console / build errors
The latest build log, runtime error log and console log are all empty, so there are currently no build or runtime errors. Type checks and 283 tests passed at the last full run.

## Root-cause summary (by impact)
1. OMNI work is blocked on GitHub organization permission. Only the owner can fix this, by installing a GitHub App or granting token access in OMERTA-ROW.
2. No test runner or Actions access, so no fix can be shown as truly tested.
3. Unpublished, so no scheduled or background work runs.
4. Missing secrets for OMNI, Razul, Brave, the webhook and the GitHub App.
5. Live voice has never been verified on a real device or network.

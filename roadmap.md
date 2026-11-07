# Jackboy roadmap

## Task Mode (Nov 7, 05:30 UTC)
- [x] Plan approved.
- [x] Phase 1: Tasks page (draft steps → review → Start → live feed → passkey checkpoints → Stop/Retry), chat can draft tasks, hourly job keeps running tasks moving. Preview: a 4-step task drafted, started, and stopped correctly because the Kill Switch is on.
- [x] Phase 2: Settings → "steps that can skip approval" per project, saved with a fresh passkey; the five never-skip types locked.
- [ ] Try a checkpoint with your passkey on the live site — needs publish and the Kill Switch off (owner only).
- [ ] Phase 3 (outside websites) — blocked until the owner picks a browser service.
- [x] Two CODE approval lanes: lane rules, server-side patch re-check, lane-aware runner checks (reviewed lane unchanged), trial labels on every CODE request and finished patch, Settings → "CODE approval lanes" panel with read-only GitHub environment checks and a per-site passkey switch.
- [ ] Apply staged database update `staging/code-lane/0051` (switch storage) — needs owner OK in chat.
- [ ] Owner GitHub steps: create CODE-AUTO and CODE-PUBLISH-AUTO (main only, no reviewers/secrets), add a main ruleset, merge the staged lane workflow, re-save CODE_TARGETS, re-pin — owner only.
- [ ] One week of trial labels, then the owner turns the lane on per site.

## Add project to CODE (Nov 7, 05:30 UTC)
- [x] "Add to CODE" card on each project page (checklist, Prepare = draft PR with the approved workflow files, Approve and activate with passkey, Remove) and a CODE sites list in Settings. Web (bun/npm) and Go workflow versions. 630 app tests + 8 isolated database tests pass; preview shows the Hercules checklist, nothing pressed.
- [ ] Apply staged database update `staging/code-sites/0050` (multi-site pins) — needs owner approval in chat.
- [ ] GitHub App needs "Workflows: write" to add the workflow file itself; until then the card shows the file to add by hand — owner choice.
- [ ] Per site: owner presses Prepare, merges the PR, creates CODE + CODE-PUBLISH environments with reviewers, sets CODE_RUNNER_AUTH_URL, saves CODE_TARGETS, presses activate with passkey — owner only, after publishing.

## Smoother buttons and live activity (Nov 7, 04:56 UTC)
- [x] Passkey window names the device method, every step times out and ends in success or failure; Connect/Activate buttons follow real state.
- [x] Live activity feed for coding loops and Code Foundry inspections: timestamped steps from real server events ("Inspecting file 12 of 51"), moving progress bar, stall warning with Retry/Stop, clear "nothing to do" end. 615 tests pass.
- [ ] Owner publishes, then tries one run on the live site — not run here, since a real scan can write a fix branch.

## One CODE activation panel (Nov 7, 03:55 UTC)
- [x] Fix live-site GitHub/OpenAI checks (edge runtime refused `redirect: "error"`); preview shows all 12 on-switch checks passing.
- [ ] Owner publishes, then presses the on-switch — owner only.
- [x] Guided walkthrough: one "Start activation" button, one step per screen with status, one button, plain blocked reason + fix, auto-advance on success; no automatic presses. Preview opens at step 7 of 7.
- [x] Kill Switch (both directions) and CODE emergency stop moved into the Autonomous Activation section; Home keeps a live status line and a link. Same passkey actions; 568 tests pass.
- [x] Readiness checks: 12 items, each with a live read-only Test (results in the site log); Block/Unblock on CODE controls and spending (existing passkey controls); statuses follow real use (passkey, gateway calls, OMNI sessions, CODE state), re-read on focus/every minute. Preview: 7 of 12 pass.
- [ ] Runner acceptance on current main, GitHub App scope reduction, backup check, OMNI link — owner actions shown in the checks.
- [x] Single ordered activation panel at the top of Settings (linked from the Home pause bar): 7 steps built from the server's 12 on-switch checks, folds away once CODE is on, emergency stop always visible; same passkey actions. 565 tests pass; preview shows 6 of 7 done.

## CODE activation prep (Nov 6, 23:55 UTC)
- [x] Staged pin update to 37368194…, cumulative $10 guard and hard-cap gate (staging/code-activation/0046–0048 + rollbacks); 15 isolated database tests pass.
- [x] App mirrors the $10 guard (fails closed when absent) and Settings shows its status; 527 app tests + CODE runtime tests pass.
- [x] 0046 applied Nov 7 00:20 UTC on owner approval: CODE_TARGETS parsed to the same SHA first; stored pin 37368194…, 1 audit + 1 Site Log row; CODE off, Stop on.
- [x] Staged 0047 ($10 guard) applied Nov 7 00:24 UTC on owner approval (journal entry 0046_code_total_spend_guard); status enforced=true, limit $10, committed $0; CODE off, Stop on, hard cap false.
- [x] Staged 0048 (hard-cap gate) applied Nov 7 00:27 UTC on owner approval (journal 0047_code_hard_cap_gate); forced-false CHECK removed, gate trigger on; flag still false, guard enforced, CODE off, Stop on.
- [x] Cost-meter secrets OPENAI_ADMIN_KEY, OPENAI_CODE_PROJECT_ID, OPENAI_CODE_API_KEY_ID now exist (values not checked against OpenAI).
- [x] Owner passkey control to mark/un-mark the hard cap (Settings → CODE): fresh passkey only, CODE off + Stop on; 9 new tests; not pressed.
- [ ] Owner presses it on the published app — owner only; needs publish first.
- [x] Live spending meter (gateway ledger + OpenAI closed-day cross-check) and passkey on-switch built; 11 isolated database tests, app and runtime tests pass; not pressed.
- [x] Staged 0049 applied Nov 7 02:27 UTC on owner activation approval (journal 0048_code_spend_meter_and_activation): meter ok ($0/$5 today, $0/$10 total); raw enable/release/hard-cap writes refused; CODE off, Stop on.
- [x] PR #46 merged (main dd629f5), 11/11 GitHub checks green; 548 app + 28 database tests pass; security scan clean; publish requested.
- [ ] Re-save CODE_GATEWAY_PRICES: saved value is 19 characters and not valid JSON, so the gateway refuses every call — owner only (secret form).
- [ ] Mark hard cap, release global pause, press on-switch — owner passkey only, on the live site.
- [ ] Controlled $1 test run + autonomous activation — blocked until CODE is on; each run still needs GitHub environment approval.
- [ ] Railway gateway/OMNI link — blocked: Lovable Cloud gives no service-role key to outside hosts; OMNI link flags off.

## Workflow pin repair and activation readiness (Nov 5, 21:30 UTC)
- [x] Independently hashed GitHub main bytes: ebc71c1923c3d6ab925ec6b9e4fa971e311f3761; both saved pins remain 82c0c44…; scope unchanged.
- [x] Production read confirms Stop ON, enabled=false, no active run and 0037 false invariant; no dispatch or paid calls.
- [x] Permanent Settings checklist distinguishes live safety reads from dated integration observations; 21 targeted tests, changed-file lint and automatic build passed; owner desktop/phone rendering verified.
- [x] Integration evidence and exact owner steps recorded in docs/WORKFLOW-PIN-REPAIR.md; OMNI drafts open, gateway/bridge blocked, physical passkey/restore/published commit unverified, App scope overbroad.
- [x] Owner approved coordinated repair; saved CODE_TARGETS read back, database pin+audit+Site Log atomically updated at 21:55:48 UTC. All three hashes match; signed-in Settings confirms Stop engaged and supervised switch disabled. Published runtime secret snapshot not verified without publishing.
- [x] Verified parser and live byte hash; supplied exact approved CODE_TARGETS JSON. Existing configuration remains unchanged; the cancelled form did not run.

## Post-merge production integration (Nov 5)
- [x] Source equals GitHub main 38664ae; exact published commit unavailable from public assets (needs trusted publish record).
- [x] Read applied history and safety constraints: CODE chain present, recovery/OMNI sessions absent; 0037 unchanged. Backup is owner-reported Nov 3 23:38 UTC, no restore test verified.
- [x] Owner pages and signed-out denial checked; original production passkey retained, physical-device assertion untested. Proposed merged workflow ebc71c19 pin, not applied. OMNI live link blocked on storage/config/hosting.
- [x] Repaired stale workflow/status evidence and expired OMNI-session reporting; 502 app tests and affected lint/build passed. CODE disabled, Stop on; no GitHub/workflow/secret changes.
- [x] Completion report records exact owner steps, pending OMNI PRs and verification limitations.

## Worker 1 supervised readiness (Nov 4)
- [x] Saved CODE_TARGETS for OMERTA-ROW/jackboy-dev-control/main, pinned live workflow blob 82c0c44e9afeacb45e666ff131e34b90ae2da23b; policy only narrows stored approval. GitHub refused environment secret-name read; owner confirmation remains unverified independently.
- [x] Hardened delayed cost/spike pause and same-request stopped state; owner dashboard stop and locked supervised toggle. 490 app tests, 44 safe CODE tests and 22 isolated database tests passed (30 skipped). Git-creating standalone tests cannot run under sandbox restrictions; no workaround attempted.
- [ ] Hosted CODE activation blocked: code_runtime_controls, reservations/provider-call storage and OMNI config_hash are absent; reviewed migrations 0036–0042, enforceable spending/runner isolation and GitHub reviewer acceptance remain required. No shared database migration or activation was authorized/applied.
- [ ] OMNI live proof failed: HTTPS handshake unavailable; hosted worker endpoint/matching keys and missing config_hash migration need owner review. CODE remains excluded from OMNI. No dispatch, workflow changes or publishing.

## Frontend conversation workflow (Nov 4)
- [x] Center submitted messages with response space; incremental-stream preview confirmed following, manual-scroll preservation and Jump to latest; older-history helper regressions preserved.
- [x] Accessible message actions, stable timestamps, local forks and safe retry drafts; retry/branch produced no chat API calls. Immediate regeneration is blocked by the existing tool-enabled transport's lack of an enforced side-effect-free mode.
- [x] 445 tests passed; automatic TypeScript/build checks passed; authenticated desktop/iPhone/iPad layouts, saved branch reload, keyboard-sized viewport and signed-out redirect checked. Browser streams were test fixtures, not paid model/CODE runs; real iOS keyboard/audio remains device-unverified. No publish or safety-setting changes.

## Feature-first queue and acting chat
- [x] Suppress new standalone test proposals; preserve critical tests and require passing checks for the changed commit before new draft PR. Existing history retained.
- [x] Shared voice/text response policy, live permission check and durable task intake; tool-derived validated repo/project/queue links; unsafe model-authored links not clickable. Signed-in text performed real OMNI check; live voice transport remains unverified.
- [ ] Automatic credit recovery blocked: no documented app-runtime balance read/API connection. Explicit 402 pauses now show "Paused: out of credits" with credit instructions in chat/queue; manual owner recovery remains, no paid inference probes.
- [x] Work-policy, link-safety and repository check regressions; authenticated text check verified no job dispatch. Full suite rerun before completion.

## Connected Projects unified resync addition
- [x] Front-side permanent Resync action with last synced time; propose missing links from token-visible names and Lovable metadata.
- [x] Single atomic review includes missing links and current profile/inventory names; preserves historical evidence and work guards. No live approval applied.
- [x] 335 regression tests passed; signed-in repeated resync displayed 15 missing-link rows and nine proposed changes. Ambiguous/absent matches remain unlinked; no repository writes or job dispatch.

## Connected Projects / OMNI follow-up (Nov 3)
- [x] Fresh per-repo token/App permission evidence and timestamps; reconcile proven obsolete PR permission errors without executing jobs. OMNI/Mothership App PR write granted, Actions read verified, Actions write denied; token identity remains street-Tech666 and fine-grained write is unknown without an operation.
- [x] OMNI key-specific setup state; OMNI_API_KEY, OMNI_API_URL, OMNI_CALLBACK_SECRET are set; missing repositories remain in the shared owner-approved review.
- [x] Named multiple passkeys, list/remove with owner-scoped fresh confirmation and atomic audit; two real virtual-device registrations/removals verified, original owner key preserved; 332 regression tests passed.

## Repository resync follow-up (Nov 3)
- [x] Permanent resync action and last checked time; owner-only load/15-minute/failure-triggered drift checks.
- [x] Token identity and honest permissions; grouped linked/moved/not-found review with atomic approved unlinking, preserving history and running work.
- [x] 329 tests passed, including PostgreSQL atomic rollback/unlink/idempotency; signed-in desktop/phone repeated resync verified. Actual reference changes await owner/passkey approval.
- [ ] Unrelated existing OMNI session schema absent: migration tool reported 0030_omni_sessions skipped due timestamp ordering; omni_link_sessions/omni_inbound_jobs not present. Left untouched to preserve current OMNI work.

- [x] Foundation: dashboard, Classic/Assist, inspect, logs/approvals, integrations, access
- [x] Technology Discovery UI (opt-in, source registry, ranking, filters, saved ideas, alerts, prototype briefs) — demo data
- [x] Secure accounts: owner/admin/member roles, invitations (create/revoke/accept), protected pages, sign out / all devices, server audit log
- [x] Owner bootstrap — approved owner email verified; real owner role and private session observed
- [x] Diagnose owner email/sign-in blocker: OWNER_EMAIL missing; sender failures now propagate, verified sign-in enforced; 12 focused tests and desktop/mobile setup/private-route checks passed
- [x] Phase 1 server-side research connector + connection test panel
- [ ] Live search results — blocked: owner must add BRAVE_SEARCH_API_KEY secret
- [ ] Jackboy account acceptance: automated permission tests plus signed-in invitation/revocation and mobile workflow checks; current published app has no sensitive external integrations
- [ ] Live discovery scans + schedule + alert delivery — blocked: needs Lovable Cloud; patent APIs (USPTO/EPO) need user API keys; AI summaries need Lovable AI
- [x] OMNI handoff queue, exportable briefs, monetization estimates, provenance + owner approvals (local only)
- [ ] Real OMNI handoff delivery — queued until Jackboy passes acceptance; then needs OMNI API endpoint + credentials
- [x] JAX release manifests (simulated), integration contract export, governance + distribution approval
- [ ] Real JAX ingest + verified payment revenue — queued after Jackboy acceptance and OMNI; then needs JAX endpoint/credentials, payment provider
- [x] Little-guy rule: two research tracks, frontier share setting, overlooked-gem flags (demo data)
- [ ] Commercial track live feedback — blocked: authorized aggregated JAX feedback feed
- [x] Agent Hub: registry, opt-in enrollment, ingest API, scoped keys, issue queue, owner-approved proposals
- [ ] Agent Hub live rollout — owner account exists and 18 Lovable projects are registered but not enrolled; still needs per-project key install, GitHub, sandbox runner and OMNI API credentials
- [x] Automation policy: learning history, checked playbooks, approval tiers, pause/revoke, decision log
- [ ] Guardian + OMNI live dispatch — blocked: authenticated Guardian and OMNI APIs and verification checks
- [x] Agent Fleet: capabilities, autonomy tiers, Guardian deny-by-default checks, emergency pause, owner dashboard
- [ ] Agent install verification (agent check-in) + sandbox/repo integrations — blocked: per-project agent runtime + credentials
- [x] Agent Passport, per-agent feedback history, OMNI job queue (local), JAX consent enrollment
- [ ] OMNI job dispatch + model adapters + Guardian verdicts — blocked: verified OMNI/Guardian APIs and model credentials
- [x] Autopilot (master + per-project), auto-connect PR, site scans, auto-fix, staged auto-ship, Jackboy chat + activity feed
- [ ] Autopilot PRs/shipping live — blocked: owner must add GITHUB_TOKEN secret and register a project with a private repo
- [ ] GitHub / VS Code / OMNI / Honeycomb integrations — blocked: user credentials & details

## November 1 Notion build update

Source: [Jackboy Updates — Competitive Advantage, Architecture & Business Foundations](https://app.notion.com/p/409c1161030681788424cd946e3d55dd?pvs=204), including its newest **Codex-style repository-level coding agent and automatic notes** section. This section records the requested build scope and verified state; a checked item means observed in the app or a real local run.

- [x] Replace sample dashboard build/service metrics with authenticated project, OMNI job, report, proposal and audit records. Preserve reversible Classic/Assist views.
- [x] Verify owner sign-in and signed-out route protection; confirm the live owner role.
- [x] Register all 18 owner-approved Lovable projects by ID as a one-time Codex-assisted snapshot. All remain unenrolled, with no agent credentials.
- [x] Queue the first OMNI internal build task privately. It remains unsent; OMNI has no verified dispatcher.
- [x] Run the local OMNI source tests, vet and build, and add a repeatable developer check.
- [ ] On the current Pro plan, continue owner-run Codex inventory sync. Official in-app Lovable API sync requires Business/Enterprise; no plan change is approved.
- [ ] Build a repository-level coding agent for Jackboy and OMNI: inspect trees, search code, trace errors, edit only authorized worktrees, run static/security checks and isolated tests, review diffs, and prepare commits/PRs. Show real terminal output and file-by-file changes; enforce per-project scope, stop/pause, bounded runs and approval for consequential actions. Do not call a UI-only suggestion or mock terminal a coding agent.
- [ ] Prove one complete OMNI inspect → patch → test → review → document workflow with a real authenticated account and stored run evidence before broad automation.
- [ ] Add source-linked, timestamped project notes after real inspections/tests/patches/deploys/rollbacks. Include project ID, revision, changed files, test outcomes and remaining work. Redact secrets, deduplicate, queue failed note syncs, and label Notion sync disconnected until linked and tested.
- [ ] Build full-screen multi-tab browser repair with explicit site permissions, tab isolation, action history, global pause/stop and owner takeover.
- [ ] Connect authorized code hosting, isolated runners, deployment and monitoring for staged rollout and rollback. Keep production, credentials, permissions and destructive actions behind owner approval.
- [ ] Add real trusted-source dependency/advisory intake, compatibility and security tests, model benchmarks, cost tracking and customer tenant boundaries before hosted/self-hosted launch claims.

The spoken acronym “NLOA” is unconfirmed in Notion. Do not infer a technical architecture from it.
- [x] Simple owner flow: Home with Connect Project, searchable Projects, connect wizard with saved-inventory picker, project detail, advanced tools under Settings
- [ ] Live Lovable project list — blocked: needs Lovable account connection (Business/Enterprise plan)
- [x] Scan & Review: demo/placeholder detection, per-finding Remove Demo/Repair/Ignore with undo, per-project automation settings, chat microphone + spoken replies (browser)
- [ ] Demo removal / repair delivered as code — blocked: GITHUB_TOKEN secret and a project with a private repo
- [x] Code Foundry slice: task state machine, immutable history, live connection states, approval → one action (draft PR), recurring rotating inspections with quota. First self-repair proven on Jackboy (draft PR #3, not merged).
- [ ] Foundry on OMNI — blocked: OMNI repo is public; owner must make it private or provide a private repo
- [ ] Foundry test evidence — blocked: GitHub token needs "Actions: read"; no sandbox runner connected
- [ ] Notion/Google/MCP adapters — blocked: owner authorization of those connections
- [x] Foundry continuous loop: auto-advance after completion, backoff retries, budgets/concurrency, global stop, push-webhook scans, Connect Accounts page. Second self-repair done (draft PR #4).
- [ ] Hourly scheduler running the new Foundry code — needs publishing (schedule hits the published app)
- [ ] Push-webhook scans — owner must add FOUNDRY_WEBHOOK_SECRET and set the repo webhook
- [ ] Deployment target / distribution step — no deploy connection authorized
- [x] Permanent site log (append-only, redacted, searchable, CSV/JSON export), report outbox for RA'SUL/OMNI/JAX with retries, GitHub code research with license checks and pattern library
- [ ] RA'SUL/OMNI/JAX report delivery — blocked: real endpoints and keys (RAZUL_API_URL/KEY, OMNI_API_URL/KEY, JAX_API_URL/KEY) and agreed receiving contract
- [x] AutoConnect slice: per-project capabilities, Approve & Connect with exact permissions, real verification (GitHub repo, GitHub Actions read, AI model), pause/revoke, auto-resume of waiting Foundry tests
- [ ] GitHub Actions read — owner must add "Actions: Read-only" to the GitHub token, then press Verify now
- [ ] GitHub App / OAuth sign-in flow for GitHub, Google, Notion — needs owner-created provider app credentials; browser runner and deploy adapters not available
- [x] Connect page multi-select (Select all/Clear, saved per user, truthful status, Connect selected, Run coding loop on selected)
- [ ] OMNI as coding target — blocked: GitHub repo OMERTA-ROW/Omni is public; Jackboy only edits private repos. Owner makes it private (or a private copy), then links it on its project.
- [ ] New end-to-end coding task verified — Jackboy's built-in checks found nothing new in its own repo; needs more repair checks or an OMNI private repo
- [x] Scan → issue → AI fix → validate → package → draft PR loop (Code Foundry, from Connect "Run coding loop")
- [ ] First low-risk auto-fix verified end to end — no low-risk defect exists in Jackboy's repo; needs another connected private repo (OMNI repo is public → refused)
- [x] Whole-workspace project list (19) with priority OMNI → JAX → Nano → Jail Release, per-project background-work activation (off by default)
- [ ] JAX, Nano, Jail Release and other projects coding — blocked: each needs its private GitHub repo linked (and OMNI's repo made private)

## Repair & Activation update (Nov 2)
- [x] Scan buttons: projects without a site address get "Add site address to scan" instead of a dead button
- [x] Chat redesign: one floating bubble → full-screen conversation, page scroll, simple composer, voice bar, tab-session continuity
- [ ] Live voice verified on a real call/device — blocked: sandbox network can't complete voice setup; needs owner test on phone/iPad
- [ ] OMNI GitHub write + Actions read — blocked: owner must install Jackboy GitHub App on OMERTA-ROW
- [ ] Safe test runner, Razul/OMNI live handoff, AI cost optimizations — not started

## Owner roadmap (Nov 2, 2026) — draft PRs only, owner approves merges/deploys/permissions
- [ ] OMNI inbox/worker draft PR — branch pushed; blocked: GitHub token lacks "Pull requests: write"
- [ ] Razul 1: authenticated API (makes RAZUL_API_URL/KEY) — blocked: Razul project has no GitHub repo
- [ ] Razul 2: AI model (Lovable AI)
- [ ] Razul 3: OMNI worker ↔ Razul
- [ ] Razul 4: Razul as Mothership central intelligence
- [ ] Mothership .env security — audited (publishable values only); branch jackboy/gitignore-env pushed; PR blocked (same permission)
- [ ] 1. Mothership endpoint/handshake for OMNI Terminal → Bridge → Mothership
- [ ] 2. Build out / optimize Mothership
- [ ] 3. Honeycomb Terminal working + connected to same flow
- [ ] 4. Jackboy site flow + more efficient, secure key/secret handling
- [ ] Fix "verify isolated CODE push" check (one-line test fix ready: add omni_connection to fake DB in tests/code-runtime.test.mjs) — blocked: no token has Contents: write on street-Tech666/jackboy-dev-control

## Owner UI/sync fixes (Nov 3)
- [x] Remove global resync banner; drift labels ignore invalidation noise
- [x] App installation repos count as inventory/writable; "No GITHUB_TOKEN set" / rejected token states
- [x] Connect selected works for connected picks (per-project resync)
- [x] Per-project resync icon + Connect/Reconnect; gone repos removable (archived, restorable)
- [x] Approve shows result or reason; neutral "No repo linked"
- [x] Rejections require/show a reason; stale personal-token task errors refreshed

## Live dashboard UX repair (Nov 3)
- [x] Chat / CODE switch in chat; CODE uses existing admission-gated backend with repo picker, job cards, approvals, run checks and draft PR links.
- [x] Classic/Assist toggle only gated guidance tips: removed toggle and "Private workspace" label; guidance setting kept on Overview.
- [x] 10-minute recent passkey reuse only for routine repo connect/review approvals; each reuse mints a fresh single-use grant; privileged actions always prompt.
- [x] Project cards: inline Add site (saved + live check), Connect for unlinked repos, refresh icon rechecks repo access + site, evidence-based connection status/last check/next step.
- [ ] Pending CODE-safety / provider-permission migrations (0036–0038) not applied → existing type errors; needs owner approval to apply to the shared backend.
## Owner requests Nov 7 (plan first, build after current queue)
- [x] Restored today's lost work (activation panel, passkey prompt, readiness, activity feed, Add-to-CODE, lanes) from the backup with GitHub PR #47 re-applied on top.
- [x] Daily morning report (7 AM Eastern, Reports page, saved once per day) and phone alerts (push, dedupe, one reminder, 30/day cap, quiet hours, retry) built; schedule every 2 minutes created.
- [x] One-press Undo: draft PRs close; merged changes need a fresh passkey, refuse on clashes, Jackboy merges its own revert after checks pass.
- [ ] Live proof: publish, register a phone on the published site, send a test alert, and receive the first 7 AM report — owner only.
- [x] Connect phone alerts to the owner's Firebase project jackboy-b6bb5 (web config from GOOGLE_API_KEY secret, VAPID key requested separately, opt-in permission, diagnostics); sending needs a server credential for that project.

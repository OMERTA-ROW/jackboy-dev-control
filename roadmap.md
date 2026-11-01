# Jackboy roadmap

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

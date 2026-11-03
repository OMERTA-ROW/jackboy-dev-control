# Repository reference audit — November 3, 2026

## Verified live state

The current GITHUB_TOKEN identifies street-Tech666 and lists 24 repositories, all under OMERTA-ROW. Resync lists all pages using `/user/repos`, without public search or GitHub App substitution. It does not test write access.

Current mappings:
- OMERTA-ROW/Omni: listed.
- OMERTA-ROW/orbiting-minds-mothership: listed.
- street-Tech666/Honeyconb-Terminal-: not listed; closest candidate OMERTA-ROW/honeycomb-terminal-companion.
- street-Tech666/jackboy-dev-control: not listed; closest candidate OMERTA-ROW/jackboy-dev-control.

No saved mappings were changed during verification. A missing repo means not returned by this token, not proof of deletion or transfer. Name similarity is only a proposal, not identity evidence.

## Mutable references and approval handling

| Storage | Role | Resync treatment |
|---|---|---|
| owner_projects.github_repo / github_branch | Current project target / branch | Replace target after owner/passkey approval; branch unchanged, development off, connection requires recheck |
| owner_projects.connect_pr_url / connect_state / connect_error | Old connection artifacts | Clear stale PR link and require reconnect |
| agent_projects.repo_url | Separate Agent Hub target | Replace matching current reference in same transaction |
| foundry_tasks.repo | Captured task target | Only unstarted discovered/blocked work without branch, commit, PR or approval may move; paused afterward |
| omni_jobs.repo | Delivery destination | Only unsent, queued, non-CODE work may move; cancel for fresh approval |
| capability_grants | Project-bound permissions | Clear GitHub repo/Actions verification; preserve revoked/expired restrictions |
| github_installations.repositories | GitHub App's selected repo snapshot | Provider-owned inventory; do not fabricate replacement access |

The service-only transaction checks owner identity, immutable review snapshot, 30-minute expiry, verified token inventory, duplicate choices and target drift. Active proposals, approval-bound Foundry/CODE work and sent/running OMNI work block project replacement. A failure rolls back all replacements. Current token inventory is rechecked before passkey consumption. Resync does not dispatch, merge, publish or change provider permissions.

## Historical / provenance references (preserved)

Repository identities occur in foundry_tasks branch/commit/PR/test data; immutable foundry_events.detail; foundry_packages.manifest; action_requests.resources (repo/ref/workflow SHA); omni_jobs.result; agent_memory; append-only site_log; audit_logs.detail; update_proposals file snapshots/PR URLs; research foundry_patterns keys/descriptions/source URLs; razul_findings.sources; releases.manifest/config; site_scans.findings; learning_events and agent-memory JSON. Arbitrary repository mentions in descriptions/instructions are text evidence, not authoritative configuration. Log outboxes reference historical Site Log IDs.

The review enumerates explicit repo fields in project/task/job/approval/memory/log records; nested provenance and free-text references are audited here rather than rewritten or treated as current targets. Completed fake-repository test records remain historical and are not replacement candidates.

## Source / settings / environment / browser audit

- Settings: GitHubTokenPanel verifies the personal token, GitHubAppPanel displays App installations, ProjectConnection configures a project. New RepositoryResyncPanel is on Settings.
- `github-app.server.ts`: PERSONAL_TOKEN_REPOS hardcodes street-tech666/jackboy-dev-control as a security allowlist; changing the project mapping does not expand it. OMERTA-ROW execution continues through the GitHub App.
- `github-token.ts`: ORG=OMERTA-ROW; verifier explicitly includes OMERTA-ROW/Omni. GitHubAppPanel has OMERTA-ROW creation/install guidance. These are identity/guidance, not mutable project records.
- CODE_TARGETS is secret JSON keyed by repo with approved ref/workflow SHA. Resync reports keys without values and never rewrites it. CODE_GITHUB_TOKEN remains separate.
- GITHUB_TOKEN, GitHub App ID/slug/private-key aliases, webhook/encryption keys and FOUNDRY_WEBHOOK_SECRET are credentials, not repository maps; untouched.
- OMNI_ALLOWED_REPOS is an OMNI-host allowlist, outside Jackboy; changing it requires owner action. OMNI_GIT_TOKEN grants separate worker access. Neither can be inferred from Jackboy's token.
- `.github/workflows/code.yml` uses GITHUB_REPOSITORY and GITHUB_REF_NAME supplied by GitHub, not a saved Jackboy mapping.
- Browser project selections store IDs, not repository identities. Chat stores historic messages. Demo-local discovery/JAX/OMNI stores are not real repo authorization; no browser canonical repo map found.
- Documentation, migrations, tests and Git history retain historical strings. No source-wide search/replace, credential change or history rewrite.

## Verification limits

Real signed-in token listing and desktop/phone replacement review passed with no page errors or horizontal overflow. Selecting a candidate did not call approval and database mappings read back unchanged. Regression tests cover token pagination/failure, name matching and explicit passkey-gated approval/cancellation. No real owner replacement was approved during this task, so a successful production transaction and real-device passkey approval remain unverified.
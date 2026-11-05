# CODE — issue #5

CODE is the exact feature name. It extends Jackboy's existing full-screen conversation and existing project/memory infrastructure. It does not replace the app or imply that OMNI, Razul or Sabrina is connected.

## Audit and implementation scope

Audited main at `0a1f8830ddcc7925a77b98030392bc4127c3af4a`. Existing infrastructure included Foundry tasks/events, `action_requests`, owner authentication, passkey step-up, GitHub App authorization, a voice relay and session-local chat history. The orb and full-screen route already existed. Generic spoken confirmation was not correlated with a particular pending action, and the conversation did not provide a real Codex job runner.

The scoped implementation reuses `action_requests` as durable job/approval IDs, adds an owner-only `/api/code` boundary, renders CODE cards in the conversation, and uses the official Codex GitHub Action as the supported execution integration. A public claim endpoint verifies GitHub Actions OIDC identity against the stored approval and atomically consumes execute/publish claims. GitHub supplies run IDs, stage progress, logs, artifact storage and cancellation. A retry creates a new approval and workflow run; it does not resume a previous run. There is no invented Codex cloud API, app-side access to this chat's tools, deployment, or merge.

Implementation order: establish the runner contract → bind consent to a server request/session/nonce/expiry → connect chat and live voice → validate evidence and destinations → add isolated checks and rollback instructions.

## Use

Type or dictate `CODE Exact project name: fix the footer` and send it. The project must have a linked GitHub repository and owner-enabled development. In live voice, ask Jackboy to request a CODE task for that project; `requestCODE` creates the same visible card.

Review the exact task, repository, permissions, request ID and expiry. Select **Allow once** or **Deny**. A spoken response is accepted only as `Allow CODE <full request ID>` or `Deny CODE <full request ID>` for the pending card in that authenticated session. A generic yes/confirm grants nothing. A live relay approval uses the original transcript, not a model-provided claim that consent was given.

Allowing dispatches only the approved workflow and task. The card links to the actual GitHub run, actual artifact records and a draft PR returned by GitHub. It reports pending, failed, cancelled and uncertain outcomes honestly. The project link uses the existing `/project/$id` route. GitHub links require the exact `github.com` origin, selected repository and resource path; GitHub enforces sign-in for private downloads.

Cancellation asks GitHub to stop the actual run. Cancellation is asynchronous; refresh until GitHub reports it. Failed/cancelled/timed-out runs can request a **new approval** for a new workflow run; prior stages are not resumed. This is not a promise of persistent model conversational state. An uncertain dispatch is reconciled by its request ID; it is never automatically sent again. If no correlated run appears after the bounded search (500 recent runs), an owner must inspect GitHub before requesting replacement work.

Pending single-use nonces and job IDs survive reloads only in user-scoped browser-tab session storage. Access tokens and task prompts are not stored there. A refreshed or different bearer session cannot decide an old card: request a new approval. Existing chat/session history and `agent_memory` remain in place.

## Owner setup — separate from this PR

The Blocker Queue now links directly to this Jackboy Lovable project and shows the three-step GitHub-key setup. A token's label (for example `Jackboy code access`) is not its secret; GitHub shows the value once. Existing repository access uses backend `GITHUB_TOKEN`, not `GITHUB_KEY`. This is distinct from CODE's separately scoped `CODE_GITHUB_TOKEN` below. Returning from key creation never grants approval: complete the visible passkey approval and real verification. Settings has passkey enrollment, linked directly from the blocker.

For a reusable owner-managed connection, the Blocker Queue also exposes the existing GitHub App's signed, provider-native installation flow, or its one-time owner setup instructions if unconfigured. Its callback verifies the installation and resumes eligible work. Invited users do not provision shared credentials or gain owner permissions. GitHub's manual token page provides no safe secret-transfer/return callback to Lovable; the guided fallback therefore has an explicit Lovable step and never pretends it installed the token automatically. Both AutoConnect and Blocker Queue require a scoped passkey for critical manual approvals and verify the configured connection before clearing blockers.

Do not enable or run the paid CODE workflow, merge this PR, provision credentials, broaden permissions, or deploy without owner approval. This local hardening adds a database migration and must not be enabled until the migration and owner-controlled GitHub configuration below are completed and reviewed.

1. Apply `drizzle/migrations/0036_code_runner_claims.sql`, `drizzle/migrations/0037_code_safety_controls.sql` and `drizzle/migrations/0038_code_provider_costs.sql` to the application database before using CODE. The RPCs are service-role-only, check the active owner and enabled repository project, and enforce a single active task and separate execution/publishing claims. Verify migration status and backups using the normal database change process.
2. Review `.github/workflows/code.yml`, its full-SHA-pinned actions and `scripts/code-patch.mjs`. Keep both jobs on GitHub-hosted ephemeral runners; do not substitute self-hosted runners. The workflow must be reviewed onto the protected default branch. The claim endpoint checks the workflow blob at both the approved branch and the signed workflow revision, and compares that revision with the owner's `CODE_TARGETS` mapping.
3. Configure `CODE_RUNNER_AUTH_URL` as a repository Actions variable containing only the reviewed HTTPS origin of Jackboy, without a path. Both `CODE` and `CODE-PUBLISH` require independent reviewers, prevent self-review and disallow admin bypass. The merged gateway runner receives no provider API secret. Provider access belongs only to the Jackboy gateway (`CODE_PROVIDER_API_KEY`, `CODE_GATEWAY_PRICES`, `CODE_GATEWAY_PER_CALL_CAP_USD`), separately owner-provisioned and reviewed. The legacy GitHub `OPENAI_API_KEY` name is not a readiness requirement. Do not put any key in chat, source, database rows or logs.
4. Create a separate `CODE-PUBLISH` environment with required owner reviewers and no model/API secrets. This independent gate protects the job that has branch/PR write permissions. A successful prepare job alone does not grant publishing; the public claim endpoint verifies the same run and a successful prepare job, then consumes a separate atomic publish claim.
5. Separately authorize a repository-selected fine-grained token for **Actions: write**, **Contents: read**, and **Pull requests: read** (never PR write for the app credential). Store it as Jackboy's backend `CODE_GITHUB_TOKEN`. Do not reuse the source-write `GITHUB_TOKEN`, share another agent's credential, or expand the existing App installation without approval. Revoke this token at GitHub to stop new job dispatches.
6. In owner-only Settings, refresh workflow evidence for `OMERTA-ROW/jackboy-dev-control` on `main`. The read-only control compares GitHub's live workflow blob with both `CODE_TARGETS` and `code_runtime_controls.allowed_targets`. A stale pin requires a separate authenticated, audited owner-approved update of both copies; refreshing never grants access, sets `enabled`, or releases Emergency Stop.

   The ref must be the actual default branch. CODE reads the workflow from GitHub and rejects missing, disabled or changed workflow blobs. The allowlist is explicit and owner-managed, not inferred from inventory. CODE does not test write permission by creating or deleting branches.

7. Confirm repository settings allow the workflow's separate publishing job to create draft PRs. This job alone has `Contents: write` / `Pull requests: write`; the Codex job has repository read access only and never receives the publisher's credential.
8. Enable development for the selected project using the existing owner-controlled flow. No new UI bypasses passkeys, OAuth, biometrics or existing role policy. The model cannot change those permissions.

Every dispatch, including manual `workflow_dispatch`, must prove a signed GitHub OIDC token to the app. Authorization is bound to the exact request ID, stored owner/session, repository, default ref, approved operation, workflow blob and base revision; approval must be active, unexpired, unrevoked, single-use, and still match the server-side allowlist. The atomic runner gate also checks the disabled-by-default mode, emergency stop, active-task slot, consecutive-failure circuit breaker, authoritative provider usage freshness, daily cap, and usage-spike pause. Missing/stale metering or an unverified provider hard cap blocks execution. GitHub and approval-service outages fail closed. Model instructions are returned only from the stored approved record; the workflow accepts no free-form instruction input. The publisher starts on a separate ephemeral job and claims independent authorization before checkout or write operations.

The isolated publisher starts from a pristine checkout and checks the patch before applying it. It refuses secret/config/auth/migration/workflow/CODE paths, traversal, symlinks, submodules, binary patches, more than 20 files, and patches over 500 KB. Tests/build run before publishing. The publisher never executes repository tests or model output while holding a write credential, never force-pushes, and creates draft PRs only. Sensitive work must use a separate explicit owner review path; CODE cannot expand its own scope.

OMNI verification status expires after five minutes and stores only a hash of the non-secret endpoint. It never stores or derives a fingerprint from either OMNI credential. Each queued OMNI job now performs a fresh authenticated handshake immediately before dispatch, validating the current bearer credential and callback HMAC proof. Missing configuration or a failed handshake blocks dispatch and clears persisted verification; the scheduled handshake is informational only. CODE uses only the separately claimed GitHub runner; OMNI cannot receive new or previously queued CODE jobs.

CODE approvals currently expire after 15 minutes. Both the execution and publishing claims check expiry; a long model/test run or delayed `CODE-PUBLISH` environment review can therefore prevent publishing even after execution was validly claimed. In that case the run fails closed and the owner must inspect its evidence and create a fresh approval before another run. Do not extend the expiry or bypass the gate without an explicit security review.

**OMNI activation blocker:** OMNI's existing job contract does not expose a CODE-specific atomic authorization claim or a separate publishing claim. The five-minute handshake prevents routing to a stale or misconfigured OMNI, but it does not provide the GitHub runner's execute/publish separation. CODE is therefore explicitly excluded from OMNI dispatch. Do not restore that route until OMNI implements and proves equivalent owner-bound execution and independent publishing claims.

## Verification and acceptance

Supported integration evidence checked on 2026-11-02:

- [Official Codex non-interactive documentation](https://developers.openai.com/codex/noninteractive), including its GitHub Action recommendation and separate read/write job pattern.
- [Audited official action inputs and implementation](https://github.com/openai/codex-action/blob/13e9c17417b29e9a276f73ec6ed7fb574137d3c3/action.yml), pinned in the workflow.
- [Official SDK](https://github.com/openai/codex/tree/main/sdk/typescript), assessed as an alternative; it is not installed or claimed as the app runner.

Local verification on 2026-11-03: `bun run test` (366 tests across 57 files), the focused CODE/OMNI/migration Node suite (36 tests), `bunx tsc --noEmit`, ESLint on changed TypeScript files with the repository's Prettier rule disabled, the production build, and `git diff --check` passed. The formatting-aware targeted ESLint check still reports legacy formatting violations in existing files; full lint is not clean. PGlite covers the migration default-off gate, exact allowlist admission, concurrent single-slot claims, two-failure stop, emergency stop/cancellation states, atomic task outcomes, and atomic/idempotent cost report ingestion. The test suites mock GitHub, OpenAI and OMNI transport; this verifies local control paths, not live provider authorization, a live CODE run, or production database migration. Compatible dependency updates removed the critical and high advisories; `bun audit` still reports two moderate and one low advisory. The prior CodeQL finding in the OMNI fingerprint is removed by using a non-secret endpoint hash and requiring a fresh authenticated handshake before every OMNI job dispatch; PR CodeQL confirmation is pending.

`Verify` CI installs the frozen Bun dependency lock before running the standalone CODE Node tests, so PGlite is available without model or production credentials. It also runs the application suite and production build. Component tests cover approval actions, expiry and the discreet accessible hang-up button. Existing voice guard tests reject unbound confirmation.

Live owner acceptance (still required):

1. With the reviewed runner and credentials authorized, speak a small CODE request in live voice. Observe the durable pending card, exact scope and expiry. Confirm no run exists before consent.
2. Deny one request; confirm no run. Allow a different request through its card or exact bound voice response. Verify the correlated GitHub run ID and immutable workflow inputs.
3. Watch actual stage progress; interrupt/reconnect voice without stopping the job. Reload the tab and refresh the job. Check that request replays and another session cannot decide it.
4. Open/download the real patch, tests and build artifacts; inspect the resulting `jackboy/code-*` branch and draft PR. Verify the project and PR destinations. Do not count a workflow success alone as evidence of a correct fix; review its diff and tests.
5. Exercise cancellation and request a freshly approved failed-stage retry. Check the audit log and retained GitHub run attempts. Verify no merge, deploy or credential handoff occurred.

No credentials or connected deployment runtime were provided in this development session. A live voice → paid Codex execution → draft PR demonstration is therefore **not verified**. The SQL migration was not applied or tested against a database. OMNI remains unverified, and no Razul/Sabrina handoff is implemented or claimed without an authenticated integration.

## Pre-activation owner review — proposed follow-up, not implemented

The local hardening diff does not yet meet the isolation or durable-history requirements below. This section is a preparation record only: it does not authorize or change a workflow, runner, credential, database, or integration. The current workflow places OIDC claim and Codex execution in the same `prepare` job, whose permissions include `id-token: write`; tests and build also run in that job. Treat the current runner as **not ready for activation** until the separation and acceptance evidence below are reviewed.

### Proposed privilege boundaries

Use distinct GitHub-hosted ephemeral jobs with a strict artifact handoff:

1. **Authorization job:** no checkout, model, tests, build, publishing credential, or application secret. Obtain the job's GitHub OIDC identity and make the execute claim. Emit only a bounded approval envelope (request ID, repository, revision, operation, instruction and claim/run correlation); do not emit the OIDC token or backend credentials. The backend remains authoritative; a downstream job must not be able to manufacture or change approval scope.
2. **Model job:** no `id-token: write`, GitHub write permissions, CODE claim URL/token, publisher credential, or production secrets. Run Codex in a fresh hosted runner with resource/time limits and only the explicitly approved source checkout. Keep the model API credential limited to the model invocation; do not make it an ambient environment variable or pass it to tests/build. The runner must not contain production data or secrets. Treat source files, task text, model output and artifacts as untrusted.
3. **Validation job:** fresh runner, no model/API key, OIDC permission, publish environment, or write token. Download a size-bounded artifact, validate provenance and patch policy, apply it to a pristine checkout, and run tests/build in this unprivileged boundary. Preserve logs/evidence even on failure. If tests need network or external services, require an explicit allowlist and use non-production fixtures.
4. **Publishing job:** separate fresh runner and protected owner-reviewed `CODE-PUBLISH` environment. Do not execute repository scripts, tests, builds, or model output here. Verify the trusted validation evidence and exact patch digest, then obtain the separate atomic publish claim before granting the narrow GitHub write token. Permit only a new branch and draft PR; deny merge, release, deployment and arbitrary push. Publishing must fail closed if evidence, claim, or service is unavailable.

Keep GitHub's built-in `GITHUB_TOKEN` permissions minimal per job. OIDC is a job-level capability, so never put `id-token: write` on a job that runs untrusted repository code. Environment secrets are available to jobs that reference that environment: no environment holding publishing or production secrets may be used by model or validation jobs. Do not assume process/sandbox flags alone provide a credential boundary; demonstrate that untrusted repository code cannot read OIDC request variables, claim bearer tokens, publisher credentials, production secrets, or the model API credential outside the intended Codex invocation.

### Durable history and Razul access

Reuse `foundry_tasks`/immutable `foundry_events` for task lifecycle where their semantics fit; do not duplicate those records. Add a dedicated append-only CODE execution event table because approval rows and short-lived GitHub artifacts do not represent every attempt or durable failure. Proposed event fields: event ID and UTC time; request/task ID; authenticated requester, approver and agent identity; project and repository; approved operation and event type; workflow/run/attempt; base and output revisions; patch/artifact digests and durable evidence references; test/build command identity, exit status and bounded sanitized result; failure category; security decision; publication state and draft PR URL. Use no raw environment, secret, token, private key, arbitrary unredacted logs, or sensitive personal data.

Insert events only through trusted server/runner evidence ingestion. Grant no update/delete to application roles; enforce immutability with a database trigger and narrowly scoped service-only write path. Retain evidence in durable, access-controlled storage beyond the ephemeral runner and configured CI artifact retention. Record artifact hashes, retention metadata and redaction status; preserve failed attempts as well as successes. Make ingestion idempotent and reject events whose request/run/project do not match the stored approval. Define retention and owner-approved archival before implementation; do not add a cleanup path that deletes the audit trail.

For Razul, add a distinct authenticated, read-only, project-scoped history endpoint or database RPC. Resolve the caller's authorized project scope server-side; never accept an arbitrary repository/project scope from the caller. Return only the sanitized event schema and authorized evidence links, with pagination, rate limits and audit logging. Grant no table-wide service role, token, write function, approval action or cross-project query. Existing Razul finding/search integration is not evidence that this history interface exists.

### OMNI contract required before routing CODE there

Keep CODE blocked from OMNI dispatch, including legacy queued CODE jobs. Future routing requires a versioned OMNI contract that: (a) verifies the same owner approval scope and signed execution identity; (b) atomically claims exact request/run/revision once and rejects expiry, revocation, mismatch and replay; (c) provides an independent one-time publish claim; (d) runs model, validation and publisher phases in isolated ephemeral environments with equivalent privilege boundaries; (e) emits authenticated, append-only execution evidence into Jackboy's durable history; and (f) offers Razul only project-scoped read-only access. Fresh handshake alone is insufficient. Verify conformance with contract tests before enabling any CODE route.

### Acceptance test plan

Run these in a disposable, non-production repository/project and isolated test database, with a non-sensitive test task and revocable low-scope credentials. Capture sanitized evidence in the durable history:

| Test                      | Required proof                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unauthorized dispatch     | Direct `workflow_dispatch`, missing/forged OIDC, wrong environment/workflow/revision, or absent owner approval creates no model execution and no claim consumption.                                                      |
| Replay and expiry         | Reused request/run/attempt, expired or revoked approval, and mismatched owner/session/project/repository/operation/revision are rejected; no duplicate model or publish action occurs.                                   |
| Concurrent claim          | Simultaneous claims yield exactly one execution winner and at most one independent publish winner in the real database RPC test.                                                                                         |
| Runner isolation          | Model/validation jobs have no OIDC permission or publisher write scope; publisher has no model credential and executes no repository/model-controlled code. Verify separate ephemeral runner IDs and clean workspaces.   |
| Credential protection     | A controlled probe confirms untrusted task/code/tests cannot access OIDC request material, claim tokens, publishing credentials, production secrets or an ambient model API key; no secret appears in artifacts or logs. |
| Durable evidence          | Successful, failed, cancelled and rejected attempts survive runner/artifact cleanup; hashes, test results, failures, decisions and publication outcomes correlate to the same approved request and run.                  |
| Razul scope/read-only     | Authorized Razul access reads only its granted project's sanitized evidence; cross-project, secret-bearing, write, update and delete attempts are denied and audited.                                                    |
| Draft-PR-only publication | Only the separate approved publish claim can create a new draft PR; no merge, deploy, release, force-push or arbitrary branch update is possible.                                                                        |
| OMNI exclusion            | Fresh OMNI verification does not route CODE; new and legacy queued CODE jobs remain undispatched until the versioned contract passes conformance tests.                                                                  |

Passing mocked unit tests is necessary but does not replace the real database atomicity test or hosted-runner credential-isolation acceptance. Do not run a paid/connected acceptance task until the owner approves the test repository, budget, credential scopes, environment reviewers and retained evidence policy. Do not merge or deploy as part of acceptance.

### Decisions requiring explicit owner approval

- Choose the disposable acceptance repository/project and approve its task, run budget and maximum resource/time limits.
- Approve the four-job privilege design, model provider credential boundary, outbound network policy and whether Codex may use any non-production fixture services.
- Approve CODE event schema, durable evidence storage, retention period, redaction rules, and the database migration/backup procedure.
- Name Razul's authenticated identity and project grants; approve endpoint/RPC authentication, rate limits and audit policy. Do not reuse a broad service-role credential.
- Approve OMNI contract versioning and require independent conformance review before enabling routing.
- Configure and review protected GitHub environments/reviewers, action pinning, repository permissions and draft-PR-only policy.

Until those decisions are recorded and the acceptance plan passes end-to-end, the changes are **owner-review materials only**; autonomous CODE operation remains blocked.

## Rollback

Before merge: close this draft PR; no live app/database rollback is needed. For a running CODE job, cancel the real Actions run and confirm its final state.

Provider metering and an enforceable provider-side daily budget are required for admission. This branch includes provider-reported daily-cost ingestion for audit and visibility, but no trusted admission meter or hard-cap verifier; the database constrains `provider_hard_cap_verified` to false and CODE remains blocked even if the remaining settings are prepared. A future reviewed migration must remove that invariant only after a trusted meter and provider-side hard limit are implemented and verified. Emergency-stop cancellation is asynchronous: the app blocks new claims immediately, records the GitHub cancellation request, and keeps the owner-facing status unconfirmed until GitHub reports the run stopped or completed. Reactivation requires a separate owner-approved change after every gate passes.

OpenAI's documented [provider hard spend limits](https://developers.openai.com/api/docs/guides/spend-limits) are monthly (organization or project scoped), and enforcement is explicitly not instantaneous; recorded spend may exceed the configured limit. Those controls cannot prove a strict $5-per-UTC-day maximum. The OpenAI CODE environment also needs an organization-admin credential for cost reporting before a provider-reported-cost ingestion adapter can be live-verified. Provider-reported costs may support audit and fail-closed admission, but must never be labeled a guaranteed daily hard cap. Keep `provider_hard_cap_verified` false until a provider-supported, bounded daily enforcement mechanism is independently verified; do not activate CODE based on estimates, delayed cost reports, or monthly spend limits.

The owner-only **Sync provider-reported costs** control reads OpenAI's organization Costs API for the configured CODE project/key and records validated USD daily buckets idempotently. Configure `OPENAI_ADMIN_KEY`, `OPENAI_CODE_PROJECT_ID`, and `OPENAI_CODE_API_KEY_ID` only as server-side secrets/configuration; the sync reports 401 (credential rejected) separately from 403 (missing organization usage permission). The endpoint's `bucket_width` is daily, and its result is observational only: sync timestamps do not update the trusted admission meter or the hard-cap verification flag. A missing, delayed, unsupported, or failed report cannot authorize CODE.

After an owner-approved merge: disable the CODE workflow, remove its owner-managed `CODE_TARGETS` entry in Settings and revoke `CODE_GITHUB_TOKEN` to stop new work. Remove/revoke the environment model credential if retiring the runner. Keep `action_requests`, audit logs and GitHub run evidence for accountability; there is no destructive migration to undo. Revert this PR through the existing owner/passkey process. Keep generic voice confirmations blocked unless an equally scoped replacement exists. A downstream CODE draft PR can be closed and its work branch deleted; if the owner merged it, revert that merge through the existing review path.

## Runner isolation: four-stage cutover, owner review pending (Nov 2026)

`.github/workflows/code.yml` is the proposed release replacement, pending owner
review and merge. `docs/proposed/code.yml` is historical design material, not a
file to copy over the strengthened replacement.

1. **Prepare:** owner-gated CODE environment, read-only checkout, request-bound
   gateway identity and no provider secret. No dependency lifecycle, repository
   tests or build runs here. Codex shell/unified-exec tools are disabled.
   The job captures the patch digest as a trusted job output and signs its
   provenance with the pinned GitHub attestation action.
2. **Validate:** no environment, OIDC or write permission. Before applying the
   patch, pristine helpers verify its digest and GitHub signature against the
   repository, source/ref and signer revision. Dependencies install with scripts
   disabled. Tests, strict types and build run inside a digest-pinned Node 26
   container: no network, no capabilities, no privilege escalation, non-root,
   resource limits, read-only source/Bun mounts and ephemeral writable storage.
   No runner home, Docker socket, job files or credentials are mounted/inherited.
   Container output is captured outside its filesystem; cleanup kills remaining
   child processes. Code cannot modify the host patch, trusted digest or uploader.
3. **Draft PR:** independently owner-gated CODE-PUBLISH environment. Both prepare
   and validate must succeed; the server independently verifies their statuses.
   It downloads the original immutable prepare artifact, not validator output,
   verifies signature/digest again, then applies the pristine path gate. No model,
   install, tests or build runs with publishing credentials. Only `jackboy/*`
   branches and draft PRs are allowed; no merge or production publishing.
4. **Finish:** records all three results, including validation failure/cancellation,
   through the existing authenticated completion/audit path. Provider usage and
   uncertain holds remain governed by the unchanged gateway ledger.

`Verify` exercises the exact container boundary without CODE dispatch and a
separate synthetic provenance canary (valid signature, modified artifact and
unsigned artifact rejection). Static regressions cover permissions, patch
tampering and job dependencies; they do not prove live CODE/passkey acceptance.
The existing full PostgreSQL/OMNI acceptance workflow remains mandatory.
Private repositories lacking GitHub attestation support fail closed; do not
remove signature verification as a workaround.

After review/merge only, an authenticated audited owner change must refresh the
exact workflow blob allowlist. Do not refresh it for an unmerged PR, enable CODE,
release Emergency Stop or change migration 0037 as part of this cutover.
Production identity/schema/backup, provider enforcement and passkey activation
gates remain independent and unverified by CI.

### Release verification and operational blockers

GitHub main `c1854a28fc373eb6171f6282ab75e3ecd1163efd` exactly matches the
requested Lovable-synchronized source commit and includes merged repair #24
(`d82d03ee46d175e980ef2789eb3c10a473bdb801`). This proves source ancestry,
not the published application identity.

Fresh hosted checks on runner repair `a744c826bc6296dd995fc57dece15ea524f63878`:

- [Verify 41812285021](https://github.com/OMERTA-ROW/jackboy-dev-control/actions/runs/41812285021):
  498 application tests, strict types and build pass. The actual container also
  passed 498 application and 36 focused Node tests, with credential/filesystem/
  network canaries. The provenance canary accepted the signed artifact and
  rejected modified/unsigned content.
- [Acceptance 41812369697](https://github.com/OMERTA-ROW/jackboy-dev-control/actions/runs/41812369697):
  155 Node tests, zero skips/failures; real PostgreSQL full 0001–0042 replay,
  rollback/reapply, spending and audit failure cases, plus real TLS
  `TestCrossLanguage` and Go suites against pinned OMNI PR #3.

Initial hosted failures (missing Git in the slim container and stale seed
derivation) were repaired, not suppressed. The disposable seed now preserves the
same signature, digest, isolated-validation and independent publishing gates;
only model generation and application-specific checks become synthetic.
No CODE job or real draft-PR publishing ran during these checks.

`OMERTA-ROW/Omni#1` and `OMERTA-ROW/Omni#3` are still draft/unmerged; the latter
is stacked on the former. The existing scoped handshake and fixed `protocol.self-test` runner are
preserved. Hosting still requires a named Node 26+ HTTPS origin, a real owner/
project/expiring approval scope, approved database access and two independently
provisioned scoped secrets. Do not start the legacy general worker or claim a
live bridge from loopback tests.

Security inspection found main reviews/admin enforcement had been relaxed.
The authorized baseline was restored and read back: one review, code-owner
review, stale-review dismissal, last-push approval and admin enforcement.
CODE and CODE-PUBLISH prevent self-review/admin bypass; an independent eligible
reviewer/operator is required. TEST/LIVE remain private and Actions-disabled.
GitHub App installation `177905883` remains all-repositories with Actions read
and workflow write; restrict its repository/permission scope before live tests.
The CODE environment still lists `OPENAI_API_KEY`; its value was never read.
The gateway workflow does not use it. A provider administrator must revoke/
rotate any previously exposed key and remove the legacy name safely.

Production remains blocked: no authenticated published-SHA mapping, schema/
migration inventory, verified backup/restore or rollback artifact, live audit/
Emergency Stop observation or passkey-bound activation is available.
Provider-enforced budget/pricing evidence remains required; migration 0037 is
unchanged. Dependency audit still reports two moderate and one low advisory,
not a clean security bill. No production migration/deployment, allowlist update,
credential change, App change, Emergency Stop release or CODE enablement occurred.

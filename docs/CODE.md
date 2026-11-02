# CODE — issue #5

CODE is the exact feature name. It extends Jackboy's existing full-screen conversation and existing project/memory infrastructure. It does not replace the app or imply that OMNI, Razul or Sabrina is connected.

## Audit and implementation scope

Audited main at `0a1f8830ddcc7925a77b98030392bc4127c3af4a`. Existing infrastructure included Foundry tasks/events, `action_requests`, owner authentication, passkey step-up, GitHub App authorization, a voice relay and session-local chat history. The orb and full-screen route already existed. Generic spoken confirmation was not correlated with a particular pending action, and the conversation did not provide a real Codex job runner.

The scoped implementation reuses `action_requests` as durable job/approval IDs, adds an owner-only `/api/code` boundary, renders CODE cards in the conversation, and uses the official Codex GitHub Action as the supported execution integration. GitHub supplies run IDs, stage progress, logs, artifact storage, cancellation and failed-job retry. There is no invented Codex cloud API, app-side access to this chat's tools, new database migration, deployment, or merge.

Implementation order: establish the runner contract → bind consent to a server request/session/nonce/expiry → connect chat and live voice → validate evidence and destinations → add isolated checks and rollback instructions.

## Use

Type or dictate `CODE Exact project name: fix the footer` and send it. The project must have a linked GitHub repository and owner-enabled development. In live voice, ask Jackboy to request a CODE task for that project; `requestCODE` creates the same visible card.

Review the exact task, repository, permissions, request ID and expiry. Select **Allow once** or **Deny**. A spoken response is accepted only as `Allow CODE <full request ID>` or `Deny CODE <full request ID>` for the pending card in that authenticated session. A generic yes/confirm grants nothing. A live relay approval uses the original transcript, not a model-provided claim that consent was given.

Allowing dispatches only the approved workflow and task. The card links to the actual GitHub run, actual artifact records and a draft PR returned by GitHub. It reports pending, failed, cancelled and uncertain outcomes honestly. The project link uses the existing `/project/$id` route. GitHub links require the exact `github.com` origin, selected repository and resource path; GitHub enforces sign-in for private downloads.

Cancellation asks GitHub to stop the actual run. Cancellation is asynchronous; refresh until GitHub reports it. Failed/cancelled/timed-out runs can request a **new approval** to rerun failed jobs; successful stages are retained by GitHub. This is workflow-stage resume, not a promise of persistent model conversational state. An uncertain dispatch is reconciled by its request ID; it is never automatically sent again. If no correlated run appears after the bounded search (500 recent runs), an owner must inspect GitHub before requesting replacement work.

Pending single-use nonces and job IDs survive reloads only in user-scoped browser-tab session storage. Access tokens and task prompts are not stored there. A refreshed or different bearer session cannot decide an old card: request a new approval. Existing chat/session history and `agent_memory` remain in place.

## Owner setup — separate from this PR

Do not enable or run the paid CODE workflow, merge this PR, provision credentials, broaden permissions, or deploy without owner approval. This PR performs none of those actions.

1. Review `.github/workflows/code.yml`, the pinned official Codex action and `scripts/code-patch.mjs`. The workflow must be reviewed onto the repository's protected default branch before dispatch is possible. Copying it to another project is a separate authorized change, not an automatic handoff.
2. Create the GitHub environment named `CODE` with required owner reviewers. Put the model's `OPENAI_API_KEY` in that environment's secret storage. The API key is passed only to the official action's protected proxy, not as a job-level environment variable. Follow the provider's native authorization and confirmation flow. Do not put any key in chat, code, database rows or logs.
3. Separately authorize a repository-selected fine-grained token for **Actions: write**, **Contents: read**, and **Pull requests: read** (never PR write for the app credential). Store it as Jackboy's backend `CODE_GITHUB_TOKEN`. Do not reuse the source-write `GITHUB_TOKEN`, share another agent's credential, or expand the existing App installation without approval. Revoke this token at GitHub to stop new job dispatches.
4. Set backend `CODE_TARGETS` to the reviewed mapping. Example shape (the hash below is a placeholder and must be replaced with the real GitHub contents/blob SHA of the reviewed workflow):

   ```json
   {"owner/repository":{"ref":"main","workflowSha":"<40-character Git blob SHA of .github/workflows/code.yml>"}}
   ```

   The ref must be the actual default branch. CODE reads the workflow from GitHub and rejects missing, disabled or changed workflow blobs. Protect that branch and review all workflow changes; the allowlist is explicit per repository, not inferred from inventory. CODE does not test write permission by creating or deleting branches.
5. Confirm repository settings allow the workflow's separate publishing job to create draft PRs. This job alone has `Contents: write` / `Pull requests: write`; the Codex job has repository read access only and never receives the publisher's credential.
6. Enable development for the selected project using the existing owner-controlled flow. No new UI bypasses passkeys, OAuth, biometrics or existing role policy. The model cannot change those permissions.

The isolated publisher starts from a pristine checkout and checks the patch before applying it. It refuses secret/config/auth/migration/workflow/CODE paths, traversal, symlinks, submodules, binary patches, more than 20 files, and patches over 500 KB. Tests/build run before publishing. The publisher never executes repository tests or model output while holding a write credential, never force-pushes, and creates draft PRs only. Sensitive work must use a separate explicit owner review path; CODE cannot expand its own scope.

## Verification and acceptance

Supported integration evidence checked on 2026-11-02:

- [Official Codex non-interactive documentation](https://developers.openai.com/codex/noninteractive), including its GitHub Action recommendation and separate read/write job pattern.
- [Audited official action inputs and implementation](https://github.com/openai/codex-action/blob/13e9c17417b29e9a276f73ec6ed7fb574137d3c3/action.yml), pinned in the workflow.
- [Official SDK](https://github.com/openai/codex/tree/main/sdk/typescript), assessed as an alternative; it is not installed or claimed as the app runner.

Local isolated suite (14 tests): `node --test --test-isolation=none tests/code-*.test.mjs` (Node 24). Covers command/voice binding, identity/session/expiry/nonce/replay checks, concurrent decisions, dispatch reconciliation, denial, cancellation, retry approvals, workflow mismatch, disabled development, missing credentials, failed audit, validated links and real Git patch checking. Database and GitHub transport are mocked; this proves the application control path, not a live Codex run.

`Verify` CI adds the same isolated suite plus the app's Vitest suite and production build, without model or production credentials. Component tests cover approval actions, expiry and the discreet accessible hang-up button. Existing voice guard tests now reject unbound confirmation.

Live owner acceptance (still required):

1. With the reviewed runner and credentials authorized, speak a small CODE request in live voice. Observe the durable pending card, exact scope and expiry. Confirm no run exists before consent.
2. Deny one request; confirm no run. Allow a different request through its card or exact bound voice response. Verify the correlated GitHub run ID and immutable workflow inputs.
3. Watch actual stage progress; interrupt/reconnect voice without stopping the job. Reload the tab and refresh the job. Check that request replays and another session cannot decide it.
4. Open/download the real patch, tests and build artifacts; inspect the resulting `jackboy/code-*` branch and draft PR. Verify the project and PR destinations. Do not count a workflow success alone as evidence of a correct fix; review its diff and tests.
5. Exercise cancellation and request a freshly approved failed-stage retry. Check the audit log and retained GitHub run attempts. Verify no merge, deploy or credential handoff occurred.

No credentials or connected deployment runtime were provided in this development session. A live voice → paid Codex execution → draft PR demonstration is therefore **not verified**. Local dependency installation was blocked by the shell's network restrictions; app build/Vitest results must come from CI and must not be described as locally passed. OMNI remains unverified, and no Razul/Sabrina handoff is implemented or claimed without an authenticated integration.

## Rollback

Before merge: close this draft PR; no live app/database rollback is needed. For a running CODE job, cancel the real Actions run and confirm its final state.

After an owner-approved merge: disable the CODE workflow, remove the backend `CODE_TARGETS` mapping and revoke `CODE_GITHUB_TOKEN` to stop new work. Remove/revoke the environment model credential if retiring the runner. Keep `action_requests`, audit logs and GitHub run evidence for accountability; there is no destructive migration to undo. Revert this PR through the existing owner/passkey process. Keep generic voice confirmations blocked unless an equally scoped replacement exists. A downstream CODE draft PR can be closed and its work branch deleted; if the owner merged it, revert that merge through the existing review path.

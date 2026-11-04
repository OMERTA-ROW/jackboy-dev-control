# CODE live acceptance in a disposable repository (preparation only)

Status: prepared, **not executed**. No repository, credential, backend, secret, variable or environment has been created. Production is untouched. Evolution and every unrelated project are out of scope.

## 1. Readiness decision

| Scope                                                                                                                                                             | Decision                                                     | Why                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub-side mechanics (environment approval, draft-only PR, branch protection, no merge)                                                                          | **READY once the owner approves a disposable repo**          | `--github-only` seed needs no Jackboy backend, no secret, no provider.                                                                                                                                                                                                                                                                |
| Negative live gates on a staging Jackboy backend (non-owner denial, passkey approval, Emergency Stop rejection, spending rejection, replay, audit, zero dispatch) | **READY once the owner approves a separate staging backend** | These all fail closed before any dispatch.                                                                                                                                                                                                                                                                                            |
| Positive path (claimed run, real draft PR from a claimed request, running-job cancellation)                                                                       | **BLOCKED BY DESIGN**                                        | Migration 0037 constrains `provider_hard_cap_verified` to `false`, so `codeStartBlockReason` always returns "authoritative provider spending data is unavailable" (`docs/CODE.md`, `docs/CODE-SPENDING-REVIEW.md`). An owner approval cannot lift this; it needs a future reviewed migration plus a verified provider-side daily cap. |

Do not weaken that constraint, in staging or elsewhere, to make a test pass. If the owner nevertheless wants plumbing coverage of the positive path, that is a separate explicit decision (D1 below) and its result is labelled "not production-equivalent".

## 2. Review findings

### Jackboy PR #17 (merged by the owner as `14f43c6`)

- Read-only token, no secrets, no environments. Runs the suites inside an empty network namespace and fails if the network canary succeeds or any node test is skipped.
- Independent of unmerged Omni work: it pins `OMNI_REF=cc083d8e51e0135f536e01f08000de7d8660acbe` of the public Omni repo. That commit stays fetchable through `refs/pull/3/head` (verified with `git ls-remote`), even after PR #3's branch is deleted. After Omni merges, re-pin to the merge commit in a small follow-up; until then the workflow keeps passing.
- Limitation: the pin makes the test reproducible, not current. It does not notice Omni drift.

### Omni PR #3 (`cc083d8e`, draft)

Reviewed `inbox/internal/link/client.go`. Compatible with Jackboy (`omni.link/v2`, `/api/public/omni/link`, same HMAC message layout; proven by `TestCrossLanguage`). Security properties present: HTTPS-only origin with no path, credentials, query or fragment; redirects refused even same-origin; response size capped; response HMAC proof checked in constant time; request nonce and job ID echoed and verified; capability set must match exactly; bootstrap and signing secrets must differ and be at least 32 characters; retries reuse the same job ID; audit failure aborts the call. No blocking defect found. Notes:

- It is **stacked on Omni PR #1** (`jackboy/omni-inbox-worker`) and imports its `inbox` package, so it cannot reach `main` before #1 or a retarget.
- 429 retries ignore `Retry-After`; low severity.
- None of this is needed for CODE live acceptance.

## 3. Isolation architecture

The CODE runner authenticates to a Jackboy backend (`vars.CODE_RUNNER_AUTH_URL`), and that backend holds the owner session, `action_requests`, `code_runtime_controls` and `CODE_GITHUB_TOKEN`. Using production for the test would mean production data, production allowlist and a production-capable token. Therefore:

- Disposable repo `OMERTA-ROW/jackboy-code-acceptance-disposable` (private, suggested name), seeded by `scripts/live-acceptance-seed.mjs`.
- A **separate staging Jackboy backend** with its own database, its own owner identity and passkey, and none of production's secrets. Needed only for the negative live gates.
- The disposable workflow has no `secrets.*` reference and no model step (a deterministic stand-in writes a marker file). A unit test enforces this.

Generate the seed locally (no network):

```
node scripts/live-acceptance-seed.mjs /path/to/empty-dir --github-only   # GitHub-side plumbing
node scripts/live-acceptance-seed.mjs /path/to/empty-dir                 # real claim/finish gates, needs staging backend
```

The workflow is derived from the production `code.yml`; derivation fails if `code.yml` drifts (`tests/code-live-acceptance-seed.test.mjs`).

## 4. Disposable repository configuration

Repository

- Private, empty, default branch `main`. Seed commit contains only the generated files plus an optional `CODEOWNERS` naming the owner.
- Branch protection on `main`: require pull request, require CODEOWNERS review, no force pushes, no deletions, **do not allow bypassing, including administrators**.
- Actions: allow only selected actions, pinned to `actions/checkout`, `actions/upload-artifact`, `actions/download-artifact`. Default workflow token permission: read.
- "Allow GitHub Actions to create pull requests" **on** (required for `gh pr create` with the workflow token). Branch protection plus CODEOWNERS keeps it from approving or merging.
- No repository secrets, no environment secrets, no deploy keys, no webhooks. `gh secret list` must be empty.

Environments (both restrict deployment to branch `main`, no secrets)

- `CODE`: required reviewer = owner.
- `CODE-PUBLISH`: required reviewer = owner (a second, independent human click).
- Repository variable `CODE_RUNNER_AUTH_URL` is only needed for the non-`--github-only` seed and must be the staging origin. It must never equal `https://jackboy-dev-control.lovable.app`.

Staging backend (negative gates only)

- Own database, all migrations through 0038 applied (0039 is not required), no production secrets, no `OPENAI_*` variables.
- `CODE_GITHUB_TOKEN` = fine-grained token limited to the single disposable repo, 7-day expiry, with:
  - Metadata: read
  - Contents: read (workflow file and branch SHA verification)
  - Actions: read and write (dispatch, run and job status, cancel)
  - Nothing else. No Contents write, no Pull requests, no Administration, no Workflows, no Secrets. Publishing uses the workflow's own `GITHUB_TOKEN`, scoped to that repo for the run.
- Owner identity and passkey enrolled on staging only.
- Allowlist entry set through the existing owner control: `{"OMERTA-ROW/jackboy-code-acceptance-disposable": {"ref": "main", "workflowSha": "<blob SHA>"}}`, where the blob SHA is `git hash-object .github/workflows/code.yml` of the seed.
- Autonomous Mode, schedules and autopilot stay off. Emergency Stop starts engaged and is released only by the owner's passkey control on staging.

## 5. Live acceptance cases

Run each in order. A case passes only if the stated evidence is captured. "Zero runs" means `gh run list --workflow code.yml` is unchanged.

| ID  | Mode                 | Case                                                                                                                                      | Expected result / evidence                                                                                                    |
| --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| G1  | GitHub-only          | Manual dispatch with a fresh UUID                                                                                                         | Run pauses at `CODE` waiting for the owner; nothing executes before approval.                                                 |
| G2  | GitHub-only          | Owner approves `CODE`, then `CODE-PUBLISH`                                                                                                | Draft PR from `jackboy/code-<id>` into `main`; PR is draft; `main` SHA unchanged; no merge.                                   |
| G3  | GitHub-only          | Workflow pushes to `main` directly (temporary probe commit step on a throwaway branch of the workflow, never on `main`)                   | Rejected by branch protection.                                                                                                |
| G4  | GitHub-only          | Cancel the run while paused                                                                                                               | Run `cancelled`, no branch, no PR.                                                                                            |
| G5  | GitHub-only          | Edit `code.yml` on a PR                                                                                                                   | Requires the owner's CODEOWNERS review before it can reach `main`.                                                            |
| S1  | Staging              | Non-owner session requests CODE                                                                                                           | Denied; no `action_requests` row allowed; zero runs.                                                                          |
| S2  | Staging              | Owner requests while Emergency Stop engaged                                                                                               | Rejected with "emergency kill switch is engaged"; zero runs.                                                                  |
| S3  | Staging              | Owner requests with Emergency Stop released                                                                                               | Rejected with "authoritative provider spending data is unavailable"; zero runs. This is the live spending-enforcement result. |
| S4  | Staging              | Replay or forged claim: call `/api/public/code/claim` with a request ID that was never approved, and with a stale or wrong-audience token | 403 each; no state change.                                                                                                    |
| S5  | Staging              | Passkey approval expiry and single use                                                                                                    | An expired or reused approval is refused.                                                                                     |
| S6  | Staging              | Audit review                                                                                                                              | Append-only records for S1 to S5, with no token, key or session material; includes the pause reason.                          |
| S7  | Staging              | Kill switch while no run is active                                                                                                        | Records and reports no cancellation needed; nothing dispatched.                                                               |
| P1  | Staging, **BLOCKED** | Approved request, claimed run, real draft PR                                                                                              | Not runnable: spending admission is blocked by design.                                                                        |
| P2  | Staging, **BLOCKED** | Cancellation of a running claimed job                                                                                                     | Same block.                                                                                                                   |

Per-gate evidence to record: command, exit code, UTC timestamp, run URL and artifact ID.

## 6. Isolation verification (before first dispatch)

Run each and keep the output.

1. `gh secret list -R <disposable>` and `gh api repos/<disposable>/environments --jq '.environments[].name'` show no secrets and exactly `CODE`, `CODE-PUBLISH`.
2. `gh variable get CODE_RUNNER_AUTH_URL -R <disposable>` is the staging origin, not production.
3. The token's repository list contains only the disposable repo; a call such as `gh api repos/OMERTA-ROW/jackboy-dev-control` with it returns 404 or 403.
4. Staging has no production secrets and no `OPENAI_*`, so `syncCodeProviderCosts` and any model call cannot run. The seed's workflow contains no provider step.
5. Production cannot be claimed against: the claim requires `claims.repository`, `sub`, `workflow_ref` and the request's repo to match, and the repo to be in the owner allowlist (`src/lib/code-runner-auth.server.ts`); the disposable repo is not in production's allowlist.
6. Network note, stated honestly: hosted GitHub runners have open egress, so the live workflow is **not** network-isolated. Protection is the absence of any provider credential or provider-calling step, plus the earlier network-namespace canary (PR #17) for the mocked suites.

## 7. Rollback and teardown

1. Engage staging Emergency Stop; cancel any run (`gh run cancel`).
2. Revoke the fine-grained token; delete `CODE_RUNNER_AUTH_URL`.
3. Close draft PRs; delete `jackboy/code-*` branches.
4. Disable Actions on the repo, then archive or delete it.
5. Retire or wipe the staging backend and its owner/passkey enrolment.
6. Production needs no rollback because nothing there is configured.

## 8. Owner approval checklist

Can be granted independently now (disposable, reversible, no production effect):

- [ ] A1. Create the empty private disposable repo and push the generated `--github-only` seed.
- [ ] A2. Apply the repository, branch-protection, Actions and environment settings from section 4 (owner as required reviewer).
- [ ] A3. Run G1 to G5, with the owner clicking each environment approval.

Needs the owner, but still non-production:

- [ ] B1. Provision a separate staging Jackboy backend (own database, no production secrets).
- [ ] B2. Apply migrations through 0038 on staging only.
- [ ] B3. Create the single-repo fine-grained token and store it only in staging.
- [ ] B4. Enrol the owner's passkey on staging and release staging Emergency Stop only when running S3 to S6.
- [ ] B5. Run S1 to S7.

Separate decisions, not part of this acceptance:

- [ ] D1. Whether to deliberately run a non-production-equivalent staging schema to exercise P1 and P2 (not recommended).
- [ ] D2. A future reviewed migration and provider-side cap that could legitimately allow admission.
- [ ] D3. Production Emergency Stop release, deployment, migrations, merging Omni PR #1 or #3, and enabling Autonomous Mode, schedules or Evolution distribution. None is required here and none is granted.

# CODE provider admission gateway (Round 14, Option 2)

Status: **implemented and mock-tested only.** `provider_hard_cap_verified` stays `false`; migration 0037's
CHECK is untouched and nothing here marks the cap verified. Applying 0042 cannot make CODE runnable
(`claim_code_runtime_slot` is still blocked by the flag). Production is unchanged.

## What it is

`POST /api/public/code/provider/v1/{responses,chat/completions}` (`src/routes/api/public/code/provider.$.ts`,
`src/lib/code-gateway.ts`, `src/lib/code-gateway.server.ts`). It is the only component that reads
`CODE_PROVIDER_API_KEY`; the CODE runner never needs a provider key.

| Requirement               | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Server-side credentials | Key read only in `code-gateway.server.ts`; `tests/code-gateway-isolation.test.mjs` fails if any other file references it.                                                                                                                                                                                                                                                                                                                           |
| 2 Atomic reservation      | `admit_code_provider_call` locks the controls row and the task reservation (0040); holds + ceiling must be ≤ `reserved_usd`. Concurrency test: 12 parallel admissions of 0.5 against 2.0 admit exactly 4.                                                                                                                                                                                                                                           |
| 3 Request ceilings        | Worst-case ceiling = body bytes × input price (a token is ≥ 1 byte) + clamped max output × output price, rounded up; per-call cap ≤ $5; tools with fees, `n>1`, background, service tier, non-text inputs and unknown models are rejected; no upstream retries (each client retry is a new reservation); streaming forces usage reporting; wall-clock timeout; Emergency Stop polled every 5 s aborts the upstream request; max 500 calls per task. |
| 4 Reconciliation          | `settle_code_provider_call` at provider-reported usage; unknown outcomes hold the **full ceiling**; `resolve_code_provider_call` (owner) needs 0041 closed-day provider evidence; `reconcile_code_provider_day` (owner) compares the provider day report with the gateway ledger.                                                                                                                                                                   |
| 5 Fail closed             | Missing key/prices/auth, admission/dispatch/audit/DB errors, missing usage, stream cut, 5xx: no upstream call, or ceiling stays held. Audit rows are written in the same transaction.                                                                                                                                                                                                                                                               |
| 6 Existing controls       | Admission/dispatch require `enabled`, `kill_switch=false`, no stop request, `cancellation_status='not_needed'`, and active request+run equal to the caller. An actual above ceiling, or unaccounted provider spend, engages `kill_switch`. Nothing releases it.                                                                                                                                                                                     |
| 7 No direct access        | **Partially met.** Code side done. `.github/workflows/code.yml` still passes `secrets.OPENAI_API_KEY` to the runner (pinned by a test as the single known bypass); cutover below.                                                                                                                                                                                                                                                                   |

Authentication: GitHub Actions OIDC (existing `verifyGithubActionsToken` + `verifyWorkflowRun(..., "execute")`),
the `x-code-request-id` header, an `allowed`, unrevoked, runner-claimed `action_requests` row whose run id and
attempt match the token, and the database re-check of the active request and run.

## Required configuration (server env only)

`CODE_PROVIDER_API_KEY` (CODE-only project key), `CODE_GATEWAY_PRICES` (JSON per model:
`inputPerMillionUsd`, `outputPerMillionUsd`, `maxOutputTokens`; unset = fail closed),
`CODE_GATEWAY_PER_CALL_CAP_USD` (>0, ≤5). Existing: `OPENAI_ADMIN_KEY`, `OPENAI_CODE_PROJECT_ID`,
`OPENAI_CODE_API_KEY_ID` for cost sync.

## Deployment instructions (not performed)

1. Owner reviews and merges #20, #21, then this PR (this PR is stacked on #21's branch).
2. Apply migrations 0030–0042 to **hosted staging first** (`drizzle/migrations`), verify, then production only with owner approval. Confirm production's `repository_resync_*` objects first.
3. Create a CODE-only provider project with a provider-enforced monthly budget and one key; set the env above on the server only.
4. Cutover `code.yml`: point `openai/codex-action` `responses-api-endpoint` at the gateway with the short-lived OIDC token as its credential and `x-code-request-id`; delete `OPENAI_API_KEY` from the repo/environment secrets; update the isolation test's pending-cutover assertion to expect zero workflow keys.
5. Rotate any key that has ever been on a runner.

## Rollback

`drizzle/rollbacks/0042_code_provider_gateway.down.sql` refuses while any call is admitted, dispatched or unknown
(resolve or abort them first), then drops the functions, trigger and table. Revert the route/lib commit and unset the env vars.

## Known limits (why the cap is still not verified)

- Token counts are provider-reported after the fact; the ceiling is an upper bound from price tables that must be verified against the provider's current pricing.
- An overrun is detected after spend (engages Emergency Stop); only a provider-side CODE-project budget bounds it absolutely.
- Gateway-side Emergency Stop is polled (≤5 s), and streaming in-flight usage is known only at completion; unknown outcomes stay fully reserved.
- Bypass is detected (day reconciliation) rather than prevented until the runner holds no key.
- Real-provider streaming, retry and concurrency behaviour is untested (mocks only).

## Staging verification requirements

1. Hosted staging PostgreSQL: replay 0001–0042, run `tests/code-*.test.mjs` with `STAGING_PG_URL`.
2. CODE-only provider project/key with provider budget, plus read-only cost access; verify prices.
3. Real-provider streaming, forced-disconnect, retry-storm and concurrent-call tests with a tiny budget.
4. Cutover verified: no provider key on any runner; direct provider call from runner fails.
5. A closed-day report + `reconcile_code_provider_day` returns `ok` after a staged day.
6. Only then, an owner-reviewed migration for the hard-cap flag with authoritative evidence.

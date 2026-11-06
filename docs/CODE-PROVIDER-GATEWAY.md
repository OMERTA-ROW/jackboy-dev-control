# CODE provider gateway and final cutover

Production step 3a preparation and read-only verification gates are documented
in [`CODE-PRODUCTION-STEP-3A.md`](CODE-PRODUCTION-STEP-3A.md). That plan does
not authorize a migration or establish production readiness.

Status: **implemented; production activation blocked pending independent staging evidence**.
`provider_hard_cap_verified` remains false and migration 0037's CHECK is intact.
No CODE jobs, paid calls, production migrations, deployment or Emergency Stop release are part of this verification.

## Release ancestry

At inspection on 2026-11-04, main was `97d2daee916d1fd42e3236e498c8c0a1b015f8f0`,
including PRs #20 and #21. PR #22 was already merged at
`ebd45794bb3af95ecaab0bd8c586f2d3e1477f00` **into #21's branch, not main**.
Consequently main did not contain the gateway. The cutover branch starts at main and
merges #22's original head without rewriting history. Its draft PR replaces the
requested retarget of the now-closed #22. Nothing is automatically merged.

## Credential and approval boundary

The pinned `openai/codex-action` accepts a `responses-api-endpoint` override and
forwards its `openai-api-key` input through its local proxy. That input now carries
**only a short-lived GitHub Actions OIDC identity**, never a paid-provider key.
The workflow obtains it immediately before Codex, masks it, and selects
`/api/public/code/provider/v1/responses?request_id=<approved-request-id>` at the
same clean HTTPS origin used by the approval/claim endpoint.

The public request ID is not a credential. The server verifies the token's
signature, audience, issuer and expiry, revalidates the current owner role and
the allowed/unrevoked/claimed action, run and attempt, then calls the existing
repository/ref/workflow/revision/environment verifier. Duplicate query IDs or
conflicting header/query IDs are rejected. No query parameter contains a bearer
credential. Authentication expires fail-closed; there is no provider-key fallback
or automatic refresh/restart of a CODE task.

Only `src/lib/code-gateway.server.ts` reads `CODE_PROVIDER_API_KEY`.
No workflow references a paid-provider secret. Other app features' credentials
must remain separate; this gateway is CODE-only, not a general app AI proxy.
The sandbox retains `workspace-write`, `drop-sudo`, read-only repository access,
and credential-free checkout. CODE-PUBLISH still needs separate owner approval.

## Spending, streaming and stopping

Migration 0042 admits each call atomically inside its existing 0040 task reservation.
Admission and dispatch recheck Emergency Stop, enabled state, cancellation and
active request/run. Concurrent calls and retries each need a separate reservation;
there are no gateway upstream retries. Holds plus actual settled costs cannot
exceed the task envelope at admission. Admission/audit failure prevents dispatch.

`CODE_GATEWAY_PRICES` is a server-only JSON map keyed by approved model, with:

- `inputPerMillionUsd` and `outputPerMillionUsd`: positive authoritative prices;
- `maxInputTokens`: independently verified **full model input/context ceiling**;
- `maxOutputTokens`: approved output limit, clamped into each request.

Reserve the whole verified input window plus the output maximum, rounded up to
microdollars, not a request-byte token heuristic. Missing input limits fail closed.
`CODE_GATEWAY_PER_CALL_CAP_USD` must be positive and at most $5; if a full-window
reservation exceeds it, reject the request rather than lower the estimate.
Images/files/audio, encrypted or stored context, previous response references,
hosted/fee-bearing tools, background work, service tiers and multiple choices are rejected.

Streaming settles only after a final completion/usage signal and EOF. A partial
usage event, disconnect, cancellation, timeout or missing usage keeps the full
ceiling reserved. HTTP status alone, including 4xx/429, is **not** zero-cost evidence.
An unmetered response is not returned as a successful completed call.
Emergency Stop/control-read failure aborts in-flight transport on the next 5-second
poll; upstream work may continue, so abort never proves zero cost or releases a hold.

Closed-day provider evidence is required for owner resolution of uncertain calls.
Provider-day reconciliation detects unattributed spending and engages Emergency Stop.
An observed cost overrun also engages Emergency Stop; detection after spend is not
proof that a hard spending cap prevented it.

## Executable isolated staging verification

`.github/workflows/code-gateway-staging.yml` runs on PRs or manual dispatch with
read-only permissions, no environments/secrets and no CODE dispatch.
It starts a disposable PostgreSQL inside an empty network namespace on a hosted
runner, proves provider egress is unavailable, runs migration/spending/rollback
and mocked gateway tests, and uploads timestamped results keyed to the tested SHA.
Synthetic identities and test data only. Dependency downloads occur before isolation.

Local equivalent with a disposable loopback PostgreSQL and the `pg` test driver:

```sh
STAGING_PG_URL=postgres://stg@127.0.0.1:54329/postgres \
STAGING_PG_MODULE_FROM=/path/to/test-driver/package.json \
node --test --test-concurrency=1 \
  tests/code-migration-chain.test.mjs tests/code-spend-staging-pg.test.mjs \
  tests/code-spend-hold-release.test.mjs tests/code-provider-gateway-pg.test.mjs
bunx vitest run src/lib/code-gateway.test.ts src/lib/code-gateway.server.test.ts
node --test tests/code-workflow.test.mjs tests/code-gateway-isolation.test.mjs
```

This proves database and mocked-provider behavior, **not real-provider billing**.

## Remaining owner-controlled staging acceptance

Read-only discovery found only `CODE` and `copilot` environments; CODE has an owner
review gate. Repository variables/secrets lists were empty. CODE environment secret
names still include legacy provider keys; values were not read or modified.
No staging origin/database, CODE-only provider project/budget, disposable repository
or CODE-PUBLISH environment was established for this task.

The following approvals can be granted independently, without enabling execution:

1. Owner review/merge of the cutover draft, approved workflow-blob allowlist refresh,
   and staging-only deployment/migrations. Production requires separate approval.
2. Owner/provider administrator removes legacy CODE environment provider keys,
   rotates any previously runner-accessible keys, and configures a CODE-only server
   key plus read-only cost-report access. Never copy production credentials.
3. Configure and verify the staging origin, approved model prices/context limits,
   and an explicitly restricted test budget. Provider budget alerts or soft
   monthly limits alone are **not a hard-cap guarantee**.
4. Approve a named disposable repository only. Restrict its GitHub App installation
   to that repository: contents read/write, pull requests write, Actions write
   only for approved dispatch/cancellation, plus metadata read. OIDC needs
   job `id-token: write`. Do not grant administration, workflow modification,
   production repository access or provider credentials to the runner.
5. Protect CODE and CODE-PUBLISH with independent owner reviews and permitted
   branches. Verify missing/expired/replayed owner/passkey grants deny admission.
   Existing owner approval tests are local evidence, not a live passkey ceremony.
6. Explicitly approve one bounded staging CODE run and independent draft-PR
   publishing. Record request/run/PR IDs, audit events, actual provider request IDs,
   streamed usage, forced disconnect/retry/concurrency outcomes, cancellation and
   Emergency Stop rejection. Block direct paid endpoints with no server credential.
7. Obtain delayed authoritative cost reports and reconcile every hold, including
   failures/cancellations. Require zero unexplained spend and independently
   verified enforcement of worst-case in-flight/retry costs. Do not equate a green
   mocked suite or an overrun detector with a verified provider cap.

Only after these gates pass may an owner-reviewed **future migration** change the
0037 constraint/flag with recorded evidence. This change does not do so.
Production health, migration approval, rollback artifact, named-repository approval
and owner/passkey-protected Emergency Stop release remain separate activation gates.

## Rollback

Engage/retain Emergency Stop and disable execution first. Do not restore the old
direct-key workflow. Roll back to a **disabled** CODE release if needed.
`drizzle/rollbacks/0042_code_provider_gateway.down.sql` refuses while any call is
admitted, dispatched or unknown. Preserve ledger/audit evidence; settle uncertain
calls using authoritative provider evidence before any destructive ledger rollback.
Never abort a dispatched call or release a hold merely because time elapsed.
Production rollback and secret changes are owner operations, not performed here.

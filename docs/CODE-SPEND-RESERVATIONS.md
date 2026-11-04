# CODE atomic spend reservations (migration 0040)

Status: **implemented and tested in isolated PGlite and disposable loopback PostgreSQL databases only. Not applied to any hosted database. The provider hard-cap gate is unchanged and CODE admission remains blocked.**

## What this adds, and what it does not

`0037` made `provider_hard_cap_verified` impossible to set (`CHECK (... = false)`), so `claim_code_runtime_slot` never admits a task. That remains true. `0040` adds a second, independent admission condition and its bookkeeping, so that when a future reviewed change legitimately opens the hard-cap gate, concurrent or back-to-back tasks cannot jointly exceed the owner-approved daily limit by admission alone.

It is **admission accounting, not a provider-side cap**. Nothing here bounds what a running job actually spends. `docs/CODE-SPENDING-REVIEW.md` still applies: a credential-bound admission proxy (or a provider that enforces a strict daily limit) is required before `provider_hard_cap_verified` may become true. `0040` does not drop, relax, or work around the 0037 constraint, and no code path sets the flag.

## Mechanism

Data (`code_spend_reservations`, one row per request, service-role only, RLS on, no anon/authenticated grants):

| status     | meaning                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `reserved` | Task admitted and running. Counts against the limit.                                                |
| `finished` | Task ended (success, failure or cancellation). Still counts.                                        |
| `settled`  | A later provider cost report covers the task; the hold is released (`released_usd = reserved_usd`). |

A trigger makes rows append-only: no deletes, immutable amounts, forward-only status, and settled rows can never change.

Controls added: `per_task_reserve_usd` (default 1.00, 0 < x <= 5.00) and `reconcile_grace_seconds` (default 900, 300–86400).

1. **Reserve (inside `claim_code_runtime_slot`).** After every 0037 check (kill switch, enabled, allowlist, workflow SHA, fresh provider data, hard-cap flag, spike, failures, daily and hourly limits), the same statement requires `reported spend today + all unsettled holds + per_task_reserve_usd <= daily_spend_limit_usd`, then inserts the hold and takes the slot in one transaction. The function locks the singleton controls row `FOR UPDATE`, so claims serialise. A request that already has a reservation cannot reserve again (replay).
2. **Finish (inside `finish_code_runtime_slot`).** The hold moves to `finished`; it is **not** released on any outcome, including cancellation. A task finishing with no recorded hold (should be impossible) records a conservative hold rather than failing open.
3. **Reconcile (`reconcile_code_spend_reservations(owner)`).** Owner-only. It runs after each successful owner "Sync provider-reported costs" and releases a `finished` hold only if the latest provider cost report was recorded at least the grace period after the task ended **and** the task started, ended and was reported within the same UTC day. The report's daily total then already contains the real cost, so keeping the hold would double count. This release is the only refund path. If reconciliation fails or never runs, holds stay counted (fail closed).
4. **App-side gate.** `codeStartBlockReason` applies the same inequality and blocks when hold data or the per-task reserve is missing, negative or non-finite.

## Known limits (deliberate, fail-closed)

- Holds for tasks spanning a UTC midnight are never released automatically; they keep consuming capacity until an owner invokes the evidence-based release procedure added in 0041.
- Holds can only be released by a provider cost report; delayed or failed syncs reduce capacity, not safety.
- The per-task reserve is an owner-configured estimate, not a measured bound.
- The 5-minute freshness and hourly spike rules from 0037 are unchanged.

## Test evidence

`tests/code-spend-reservation.test.mjs` (16 tests, in-memory PGlite, synthetic IDs, no network) and the new cases in `src/lib/code-safety.test.ts`. Admission-path tests drop the 0037 CHECK **in the throwaway database only**; one test proves the real schema still rejects `provider_hard_cap_verified = true` and still refuses every claim, before and after the rollback.

Covered: claim serialisation (3 simultaneous claims → 1 hold), cumulative cap with zero reported spend (5 admitted, 6th and 7th refused), reported spend + holds, stale/missing/future provider data, disabled/killed/spike/failure states, replay, Emergency Stop, cancellation holds, conservative finish, append-only history, reconciliation (grace, same-day, cross-day, active, non-owner, idempotent), refund restoring capacity, migration atomicity on failure, rollback refusal with open holds, rollback restoring 0037 behaviour, and re-apply.

A mutation check (removing the holds term from the claim inequality) makes 3 of these tests fail.

## Rollback

`drizzle/rollbacks/0040_code_spend_reservations.down.sql` restores the 0037 functions and drops the table, trigger and columns. It refuses to run while any unsettled reservation exists. Procedure: engage Emergency Stop, wait for the active task to finish or cancel, run an owner cost sync so holds reconcile, then run the script. The rollback and the migration never alter `provider_hard_cap_verified` or its CHECK. Because the table is dropped, export `code_spend_reservations` first if its history must be kept.

## Live verification still required (not done)

1. Concurrency and transaction rollback behavior have been checked with the disposable loopback PostgreSQL suite described in Round 12. Applying 0040 to a hosted staging database that mirrors production, and a staged migration rollback, remain unverified.
2. A real OpenAI cost-report cycle in a non-production project to confirm that reports land within the grace window; tune `reconcile_grace_seconds` from evidence.
3. A credential-bound admission proxy or provider-enforced daily cap, then an owner-reviewed migration to open the hard-cap gate. Until then CODE stays blocked.
4. Owner-gated server functions and passkey step-up for the 0041 hold-release RPCs.

Migration numbering: `0039_recovery_codes.sql` has no `_journal.json` entry on `main`; this PR does not change the journal.

## Round 13 additions

### Migration chain (0030 baseline)

`0031_repository_resync_drift_removals` and `0033_unified_project_repository_resync` build on objects (`repository_resync_reviews`, `apply_repository_resync[_internal]`, the guard triggers) that were created by a `0030_repository_resync_review` that exists only on the diverged `lovable-sync` branch. Main's 0030 slot is `0030_omni_sessions`, so an empty database could not replay the chain. `0030_repository_resync_baseline.sql` creates each missing object only if absent (guarded by `to_regclass`/`to_regprocedure`/`pg_trigger`), never replaces or drops an existing one, and installs a fail-closed placeholder that 0031 immediately replaces. It is a no-op on any database that already has the objects. It has no down script: dropping those objects would be destructive. Verify in hosted staging that production already contains them (compare `to_regclass`/`to_regprocedure`) before assuming it is a no-op there. `tests/code-migration-chain.test.mjs` covers fresh replay, gap reproduction, idempotence, divergent pre-existing objects, atomic failure and 0041/0040 rollback with re-apply.

### Cross-day hold release (0041)

0040's reconcile only settles holds whose whole life and report fall in one UTC day, so cross-day holds stay reserved indefinitely (fail closed). 0041 adds an owner-only, evidence-based release:

- `record_code_closed_day_costs(actor, day, rows, synced_at)` records a provider cost report for a **closed** UTC day, accepted only if `synced_at >= day end + closed_day_lag_seconds` (default 6h, 1h–48h). Rows use the same validation as the live sync. Evidence is append-only (`code_provider_cost_day_reports`).
- `release_code_spend_holds(actor, request_ids[], reason)` releases explicitly named, `finished` holds, all-or-nothing, only if every UTC day from creation to finish has a report recorded after both the day's close+lag and `finished_at + reconcile_grace_seconds` (the finish day may use the live report). Anything missing raises and nothing is released. Each call writes an audit row with per-hold evidence.
- A date change or timeout alone never releases. `reserved`/running holds are never releasable. Cancelled holds need the same evidence.

Limits: the evidence is the owner-recorded total of a provider report; the function cannot prove the report is complete or that the provider cap held. There is no server function or UI for these two RPCs yet; calling them requires the service role with an owner id. Adding owner-gated server functions (and passkey step-up) is a follow-up.

### Hard-cap options (provider_hard_cap_verified stays false)

Reservations bound admission, not what a running job spends.

- **A. Dedicated CODE-only project/key with provider cap.** Provider limits are budget-level (monthly) and eventually consistent; usage reports lag. It cannot guarantee a per-task or daily limit against in-flight, retried, streaming or concurrent calls. Useful as an outer blast-radius bound only; cannot be verified without a real provider project.
- **B. Credential-holding admission proxy.** The only design that could enforce the limit: the runner never holds the key; every request reserves its worst case (input estimate + `max_tokens` ceiling) atomically before forwarding; retries are new reservations; streams are cut at the ceiling; settlement uses provider-reported usage; uncertain usage stays reserved; the proxy fails closed when the DB or audit log is unreachable. It must be tested with a real provider in staging and its coverage of every outbound path proven.

Neither can be verified in an offline/mocked environment, so the gate is **BLOCKED**, `provider_hard_cap_verified` remains false and the 0037 CHECK is untouched.

## Round 12: real-PostgreSQL staging verification (historical)

The findings below describe the state before the Round 13 changes. The Round 13 additions above provide the migration-chain baseline and evidence-based cross-day hold-release RPCs; the remaining follow-up is to expose the RPCs through owner-gated server functions with passkey step-up.

Environment: a disposable, loopback-only PostgreSQL 18 (embedded-postgres, no production credentials, synthetic data, no outbound provider access). Nothing here is a production or hosted staging database.

Run the same suites against it with:

```sh
STAGING_PG_URL=postgres://<user>:<pw>@127.0.0.1:<port>/postgres \
STAGING_PG_MODULE_FROM=/path/to/dir/with/pg/package.json \
node --test tests/code-spend-reservation.test.mjs tests/code-spend-staging-pg.test.mjs
```

- `tests/code-spend-reservation.test.mjs` runs on PGlite by default; with `STAGING_PG_URL` it runs unchanged on real PostgreSQL (one throwaway database per test). Non-loopback hosts are refused.
- `tests/code-spend-staging-pg.test.mjs` (skipped without `STAGING_PG_URL`) adds true multi-connection checks: 16 parallel workers over many backend connections never exceed the daily limit; a competing claim is observed blocked on the controls row lock (`wait_event_type = Lock`); rolled-back claims leave no hold; audit-log failure, unreadable usage table and missing/stale/future provider data all fail closed with zero holds; `anon`/`authenticated` are denied; the cost-report lifecycle (hold → finish → report → reconcile → refund) and non-owner denial; a cross-UTC-day hold is never auto-released.
- Mutation check: removing `held_spend` from the claim makes 3 of the real-PostgreSQL tests fail.

### Known gaps found at Round 12

- Cross-day holds: an unsettled hold from an earlier UTC day still counted against that day's limit and had no release path. The evidence-based procedure was added in Round 13 above; without authoritative evidence, releasing such a hold would weaken the gate.
- `0031_repository_resync_drift_removals.sql` and `0033_unified_project_repository_resync.sql` referenced `repository_resync_reviews`, which no migration created, so the migration chain could not be replayed from an empty database. The Round 13 baseline above addresses this gap.

### What must exist before `provider_hard_cap_verified` can be enabled

Reservations bound _admission_, not _spend_. One of the following authoritative controls is required, with evidence recorded by a separate reviewed migration:

1. A provider-enforced limit on a dedicated, CODE-only project and key (hard budget or per-key cap that the provider itself rejects over), verified by an owner-observed provider-side setting and a staging probe that is refused at the cap; or
2. An admission/metering proxy that holds the only copy of the provider credential, counts tokens per request against the reservation, rejects over-budget calls before they reach the provider, and writes usage to `code_usage_events` transactionally; runner jobs never see the raw key.

Until then the 0037 CHECK stays in force and the gate stays closed.

# CODE atomic spend reservations (migration 0040)

Status: **implemented and tested in isolated PGlite databases only. Not applied to any real database. The provider hard-cap gate is unchanged and CODE admission remains blocked.**

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

- Holds for tasks spanning a UTC midnight are never released automatically and keep consuming capacity until a reviewed owner-release procedure exists (not implemented here).
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

1. Concurrency on a real multi-connection Postgres (PGlite is single-connection; correctness relies on the row lock, and is not demonstrated under true parallel sessions).
2. Applying 0040 to a staging database that mirrors production, and a staged rollback.
3. A real OpenAI cost-report cycle in a non-production project to confirm that reports land within the grace window; tune `reconcile_grace_seconds` from evidence.
4. A credential-bound admission proxy or provider-enforced daily cap, then an owner-reviewed migration to open the hard-cap gate. Until then CODE stays blocked.
5. A reviewed owner procedure for releasing cross-day holds.

Migration numbering: `0039_recovery_codes.sql` has no `_journal.json` entry on `main`; this PR does not change the journal.

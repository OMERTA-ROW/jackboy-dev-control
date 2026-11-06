# CODE production step 3a: disabled migration review

**Review only.** This document prepares an owner-reviewed production migration
through journal entry 0043, with CODE disabled and Emergency Stop engaged. It
does not authorize an execution, change production, release Emergency Stop,
enable a schedule, dispatch a CODE job, or make a provider call. No migration
runner or automatic production workflow is added. The production database,
deployed app version, migration history, credentials and provider configuration
have not been inspected for this draft. A separate approval for the exact
target, migration set, execution method and commit is required after review.

## Migration scope and stop conditions

The existing production candidate is the reviewed application migration chain
up to **journal index 43**, ending in
`drizzle/migrations/0043_code_provider_gateway.sql`. Journal order and filenames
are not interchangeable: 0039 repeats the 0036 runner claims; 0040 repeats the
unjournaled 0036 permission-events migration; 0041 is spend reservations;
0042 is hold release; and 0043 is the provider gateway. The earlier numbered
copies have equivalent SQL except trailing whitespace and must not be blindly
executed a second time. `0030_repository_resync_baseline.sql` is unjournaled
but supplies objects needed by 0031 in a fresh replay; its production necessity
is unknown. `0039_recovery_codes.sql` is also unjournaled and is **not**
automatically included. Index 44 and later are out of scope; if already applied,
leave them and their journal entries intact. Staging's handwritten journal and
stand-ins are not a production migration path.

Before any proposed write, an authorized database operator must independently:

1. Establish the exact production project, database and credential scope using
   provider-owned resource metadata and normal hostname-verified TLS. Do not
   use the staging marker, staging URL, or staging CA-only hostname bypass.
   Record non-secret resource identifiers, deployment SHA and timestamp.
2. Obtain an owner-approved, restorable backup and point-in-time recovery plan;
   verify a restore on an isolated environment, including roles and grants.
   Record who can execute recovery, expected data loss window and dependencies.
3. Use a read-only transaction to inventory actual schema objects and the
   Drizzle migration journal, including timestamps and hashes. Compare every
   entry through 0043 with the exact reviewed repository artifacts, including
   the unjournaled baseline and duplicate SQL copies. Compare current
   definitions, dependencies, grants, existing data and any already-applied
   later migrations. Resolve any gap, hash mismatch, duplicate, divergent
   object, unknown history or partially applied migration in a new reviewed
   plan; **do not** infer missing migrations from the highest timestamp, forge
   journal entries, replay the whole chain, or use staging's bootstrap.
4. If CODE controls already exist, read the singleton and require `enabled =
false`, `kill_switch = true`, `provider_hard_cap_verified = false`, no
   active request or run, and the validated 0037 constraint exactly
   `CHECK ((provider_hard_cap_verified = false))`. If they do not exist,
   confirm no executor or scheduler can dispatch while the initial controls
   are absent; 0037 creates them stopped. If any condition is false, unknown or
   cannot be verified, **stop**. Engaging a stop or modifying existing controls
   is a separate owner-approved operation, not an implicit repair in this plan.
5. Inventory active claims, open provider calls, spend reservations and pending
   jobs, and confirm the application/workers and migration mechanism can remain
   quiescent for the change. Verify the intended runner's transaction, lock,
   migration ordering and journal behavior on a representative isolated clone.
   Produce an exact pending-file list, expected hashes, pre/post schema and
   per-file recovery steps for explicit owner approval.

After those gates, the operator may propose applying **only** the independently
verified missing, approved migrations using the existing controlled database
change process. Stop on the first failure or unexpected state; do not retry,
repair a journal, skip a migration or proceed to activation automatically. A
successful migration is not permission to deploy code or run CODE. Verify the
postconditions below with a read-only transaction and record evidence.

## Read-only post-migration verification plan

Use production-supported read-only interfaces and authenticated operator
sessions, with no secrets, tokens, personal records or raw claims in evidence.
Record timestamps, non-secret target identifiers, exact reviewed migration
hashes and sanitized pass/fail results. These steps are a **plan**, not results.

| Area                   | Evidence to collect without modifying production                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Controls and migration | Read the singleton: disabled, kill switch true, cap flag false, no active request/run, daily limit at most $5; inspect the validated 0037 CHECK, migration journal and expected 0041–0043 objects/functions. Verify no staging-only marker or gate migration was used.                                                                                                                                                                                                                            |
| Real authentication    | In a separately established, already-authenticated owner session, inspect the verified identity and `my_role` via the actual deployed application's read-only role/status surfaces. Independently inspect anonymous and non-owner read-only access. Do not infer identity or session validity from stand-ins or database role names.                                                                                                                                                              |
| Passkeys               | Inspect enrolled/available passkey status and deployed owner step-up enforcement through authorized read-only surfaces and reviewed code/configuration. A fresh WebAuthn assertion or mutation-bound approval can update counters, sessions or audit state; it is **not** a read-only test and needs a separately approved live ceremony. Presence of an enrollment alone is not proof of working step-up.                                                                                        |
| RLS and authorization  | Inspect actual RLS enabled/forced flags, policies, ownership, function security settings and grants for CODE controls, reservations, provider calls, approvals, passkeys and audit tables. Compare expected access with actual `anon`, `authenticated`, owner and service identities using approved read-only queries and existing authenticated sessions. Do not use a privileged role as a proxy for a user session.                                                                            |
| Credential isolation   | Inspect secret _names_, deployment bindings, provider key/project metadata, runner/workflow/environment permissions and network/egress configuration using authorized read-only admin views. Do not reveal or export secret values. Establish whether only the gateway has the CODE provider credential and whether other services or keys can spend against the same project. Configuration inventory alone does not prove runtime isolation; adversarial/live probes require separate approval. |
| Audit and stop         | Read existing audit configuration, permissions and stopped controls. A new audit insertion, denied privileged mutation, stop action or rollback test is not read-only; separately authorize any such production action. Existing local/staging tests do not establish production audit or cancellation behavior.                                                                                                                                                                                  |

## Spending controls: evidence versus claims

- The owner accepted an OpenAI project hard limit of **$10** and the existing
  **$5 UTC-day app limit**, including small overshoot risk. That decision is
  not proof that the current production gateway key belongs to that project.
  The earlier owner-observed provider screen was point-in-time evidence, not a
  live check in this change. Before any future activation, an authorized owner
  must independently inspect the current project limit, credential-to-project
  association, other project spenders and cost-report scope without revealing
  the key. Provider hard-limit enforcement can lag and is not a strict
  instantaneous or daily cap.
- Source implements a maximum $5 daily limit in
  `drizzle/migrations/0037_code_safety_controls.sql` and
  `src/lib/code-safety.ts`; journaled `0041_code_spend_reservations.sql`
  atomically adds outstanding holds and the task reserve to reported spend
  before admitting a claim. `0043_code_provider_gateway.sql` controls
  individual gateway calls inside reservations. These controls are not proof
  of production installation or complete accounting for external spend.
- `src/lib/code-gateway.server.ts` reads `CODE_PROVIDER_API_KEY` server-side;
  its source does not establish that the credential is configured or bound to
  the owner's $10 project. No `provider_hard_cap_verified` flag is set by this
  plan. The validated 0037 constraint continues to force it false, so CODE
  admission remains blocked even if the other controls are present.

## Rollback and recovery plan

Keep CODE disabled and Emergency Stop engaged; do not revert to a runner with
direct provider credentials. Treat migration rollback as a separate,
owner-approved production write with a verified backup and a rehearsed
operator-specific plan. On an uncertain commit or interrupted connection,
inspect actual journal and schema state read-only before deciding anything.

For changes actually introduced by this operation, verify dependencies and
preserve the immutable audit, cost, hold and provider-call records in an
approved access-controlled backup before any destructive rollback. The
repository supplies these reverse-order scripts, named for their original
unjournaled copies:

1. Journal 0043 gateway: `drizzle/rollbacks/0042_code_provider_gateway.down.sql`
   refuses unresolved admitted, dispatched or unknown calls.
2. Journal 0042 hold release:
   `drizzle/rollbacks/0041_code_spend_hold_release.down.sql` refuses while
   any reservation is unsettled.
3. Journal 0041 reservations:
   `drizzle/rollbacks/0040_code_spend_reservations.down.sql` refuses unsettled
   reservations and restores earlier claim functions.

These scripts drop schema and can destroy history; do not run them merely
because a check failed or mark unknown costs settled. Preserve evidence and
reconcile only with authoritative provider evidence under separate approval.
Reconcile migration journal state with the actual runner and approved rollback
plan; the down scripts do not automatically repair the Drizzle journal. Earlier
app migrations and the unjournaled 0030 baseline have no general safe down
path. For those or incompatible downstream dependencies, use the rehearsed
backup/PITR plan rather than inventing a destructive reverse migration. Verify
disabled controls and the 0037 constraint after any authorized recovery.

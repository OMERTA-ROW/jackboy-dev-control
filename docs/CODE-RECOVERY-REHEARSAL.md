# CODE migration 0059/0060: isolated PostgreSQL 17.11 rehearsal

This is a local recovery rehearsal, not a production migration procedure or an
activation approval. The migration SQL is unchanged from `d458517eec82b920be4d4bcb9f66f77e8ea57a53`.
The original filtered restore remains untouched.

## Repeatable procedure

Run from the repository root using the existing local Docker Unix-socket context:

```sh
node --test tests/code-recovery-harness.test.mjs tests/migration-history-reconcile.test.mjs
node scripts/rehearse-code-recovery.mjs
```

The harness intentionally accepts no alternate resource targets. Its reviewed
source is `supabase_db_jackboy-recovery-test`, database `jackboy_backup_restore`.
It verifies the PostgreSQL 17.11 Supabase image and the exact 0058 journal anchor,
and refuses a different baseline, subscriptions or foreign servers. No production
connection string, password, provider token or role password is read or requested.
Use a reviewed code change to support another source; do not point this harness
at a production container.

Each invocation creates a uniquely named disposable container using the source's
exact local image ID. It has network mode `none`, no published ports or host/data
volume mounts, a read-only root filesystem and temporary PostgreSQL storage.
PostgreSQL accepts only Unix-socket connections through `docker exec`.
All copied roles are NOLOGIN, worker capacity and WAL senders are zero, and no
application, scheduler, Supabase API or external worker runs in the container.
The test verifies these properties before migration. Even while historical
enabled settings are briefly present during restore, there is no connection or
worker execution path.

The archive streams directly between containers, not into a persistent host file.
Vault secret data is explicitly excluded. Ownership and ACL restoration are
mandatory: neither `--no-owner` nor `--no-acl` is used. Catalog fingerprints compare
public/auth/Vault function ownership and ACLs, table/sequence/view grants and RLS
flags, role capability flags and membership options before any migration changes.
These comparisons establish fidelity to the **local filtered restore**, not to
uninspected production permissions. Column grants/default grants and the entire
provider-managed recovery contract still require independent review.

## Managed Supabase restore incompatibilities

Restoring as Supabase's restricted `postgres` role failed on Vault ownership and
grant-option replay. The disposable cluster recreates the source's owner/grantee
roles without passwords. `pg_restore` connects as a temporary bootstrap superuser
and uses `SET ROLE supabase_admin`, preserving the managed extension owner and
grantor. The source `supabase_admin` role is used only for authorized read-only
catalog inspection and `pg_dump`; no source grants are changed.

Supabase also owns several event triggers with `postgres` despite that role no
longer being a superuser. PostgreSQL requires a superuser owner when assigning
event triggers. Only in the network-none, NOLOGIN disposable cluster, `postgres`
temporarily receives the flag during restore; it is removed immediately afterward.
The capability/ACL comparison must then match the source, before testing begins.
Both migrations run as this restored **non-superuser `postgres` owner**, not the
bootstrap superuser. This is not permission guidance for production.

The restored `pg_net` extension requires its library to be preloaded. The rehearsal
preloads it solely for schema compatibility while `max_worker_processes=0`,
`max_wal_senders=0`, no TCP listener and Docker network `none` prevent execution
and outbound delivery. The harness independently verifies there are no worker
backends. Cron is not enabled.

## Assertions and cleanup

Before migration, the disposable copy must have zero reservations and no active
request/run. The harness disables CODE, engages CODE Emergency Stop and global
pause, and clears historical meter freshness. It never enables CODE, updates
workflow pins, attests a provider hard cap, consumes a passkey or dispatches work.

For 0059 and then 0060, each SQL file and its exact hash/timestamp journal insert
run in one transaction. An injected late exception first proves rollback of
function bodies, triggers, controls, audit row count and journal state; then the
same migration is installed normally. The harness uses the repository journal's
timestamps, not database row IDs as migration numbers.

`tests/fixtures/code-recovery-verification.sql` runs synthetic probes inside a
transaction that is always rolled back:

- exact enabled BEFORE INSERT ROW acceptance trigger identity;
- migration function ownership, service-only claim/readiness and owner-role
  Guardian entrypoint privileges;
- disabled/misattached trigger detection and refusal of a stopped-runtime claim;
- rejection above the $1 acceptance hold and accounting of a permitted $1 hold;
- rejection of daily ceiling configuration above $5 and cumulative above $10;
- all-time accounting of prior-day $10 costs and rejection of the next hold.

No runtime is activated to exercise positive daily admissions in this restored
database. The existing synthetic/no-egress acceptance tests separately cover
exact $5 daily admission and concurrent $5/$10 boundaries. Do not equate a ceiling
constraint probe alone with a full provider spending test.

Finally the harness verifies 0059/0060 journal hashes and stopped settings. It
removes only its uniquely named disposable container and compares the original
recovery database's controls, journal, reservations, OMNI rows, audit row count,
public function definitions/ACLs and reservation triggers with the initial
fingerprint. A source change causes failure, including concurrent external edits.
No restored payload is written to the report. Source fingerprints are scoped
safety checks, not a full database/backup checksum.

## Observed result and outstanding recovery gates

On November 9, 2026 the rehearsal succeeded using PostgreSQL **17.11** and local
image `sha256:7bd84e6a1d5322c7b864b9751873a0ac50f48df3f20a776e88114eadb2948fc0`.
Both migrations and injected failure rollbacks passed. Final disposable settings:
CODE disabled, Stop engaged, no active request/run, daily $5 and cumulative $10.
The original recovery fingerprint was unchanged and the disposable container
was removed.

The filtered source had 322 validated public constraints and a matching 0058
journal anchor, but also historical enabled CODE settings and default PUBLIC
execute on the claim function. Fidelity preserves that pre-migration ACL;
0060's explicit revocation fixes the claim entrypoint in the disposable copy.
Other restored function grants remain subject to a full least-privilege review.
This does not establish that production has those grants.

**Full recovery and production release remain BLOCKED** pending:

- Provider backup ID/timestamp, backup integrity, PITR window/retention, authorized
  target identity and a verified recovery point/RPO/RTO.
- Cron definitions, dependencies, scheduler state and a no-dispatch recovery test;
  excluded schedules must not silently become active during recovery.
- Exact identities/definitions/versions/privileges of the two excluded Realtime
  functions and provider-supported recovery evidence. Remaining Realtime objects
  do not prove the missing functions recovered.
- Provider-native Vault-secret/key recovery, encryption compatibility, ownership,
  permissions and consumer checks. This rehearsal intentionally restores **zero
  Vault secret rows** and cannot prove secret recovery.
- Current production migration journal/hash reconciliation, roles, grants, RLS,
  extension and trigger verification through authorized read-only access.
- Separate owner approvals for any production migration and publication, with
  verified stopped/quiescent CODE and the existing backup/forward-repair plan.
  Activation, paid tests and live OMNI dispatch remain independently prohibited.

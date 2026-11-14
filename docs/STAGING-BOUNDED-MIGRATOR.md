# Bounded staging migrator (not executed)

This manually dispatched workflow is a code-only proposal, not approval to run,
deploy, merge, or enable CODE. It does not modify migration SQL or the repository
journal. No staging or production database was accessed while implementing it.

## Fixed target and approval

Only the existing protected GitHub `staging` environment may provide
`STAGING_DATABASE_URL` and base64-encoded PEM `STAGING_DB_CA_CERT`. The URL must
have credentials, no query/fragment, and exactly this target:

- Host `shinkansen.proxy.rlwy.net`, port `48734`, database `railway`.
- Environment `83515d1e-141f-4fd1-8dfb-50764a73a5db`.
- Postgres service `f0c879d1-1934-4b5b-b4e6-728bc807d51d`.

The live `public.jackboy_staging_identity` must contain exactly one matching row.
The runner never creates or repairs the marker. The repository, main ref,
workflow ref/SHA, checkout SHA and exact approved input SHA must all agree.
Checkout resolves current main; a main moved before checkout fails closed. The target confirmation
is `railway-jackboy-staging`. Workflow reruns are rejected. Concurrency shares the
existing bootstrap group; an advisory transaction lock also coordinates with
bootstrap, and identity/journal/control/reservation table locks prevent concurrent writes.

Environment protection/reviewer configuration was **not inspected or changed**.
It must already enforce separate owner approval; the input is not an approval
grant by itself. Nothing here dispatches the workflow.

## Normal Drizzle history, fixed cutoff

The installed `drizzle-orm` 0.45.4 / Postgres.js 4.0 runner uses the supported
`migrationsFolder` API. A temporary folder contains exact SQL bytes only from the
first 65 original journal entries. Before each call, its journal is an unchanged
prefix of the original entries, with original timestamps and metadata retained.
This is not a replacement database journal or manual SQL executor: Drizzle alone
splits statements, computes hashes and inserts normal
`drizzle.__drizzle_migrations` rows.

The starting history must be exactly 44 ordered, hash/timestamp-verified rows
through `0043_code_provider_gateway`; any missing, altered or later row fails.
Calls expose one new entry at a time, 0044 through
`0064_omni_configuration_probe`, never 0065+. No cutoff input exists.
Postgres.js 4.0's supported nested `begin()` creates savepoints inside one outer
transaction. All prechecks, migration calls and history verification use that
same client/transaction; the first failure rolls everything back. Successful
completion requires exactly 65 verified rows through 0064, matching identity,
and stopped CODE. No automatic resume or retry exists. A network failure at
commit can have an uncertain outcome: obtain separately authorized read-only
history evidence, never rerun blindly.

Before 0054, the runner checks the exact seed slugs `omni`, `jax`, `razul`,
`iggy`; changed seed definitions, an existing matching slug, or a pre-existing
`chat_contexts` table fail closed. It does not delete or reconcile seed data.
Before 0061 (and at completion), actual control definitions require
`enabled=false`, `kill_switch=true`, both active IDs null, limits $1/$5/$10,
global `automation_policy.paused=true`, and no reservation with
`status='reserved'`. Missing/unreadable checks fail; controls are never changed
by runner guard code. Entry checks the same stopped state and $1/$5 limits,
without querying the total-limit column introduced by 0046. Native migration
assertions remain intact.

## TLS and run-readiness prerequisites

CA and hostname validation are both mandatory. The connection has an explicit
CA, `servername` equal to the fixed host, and `rejectUnauthorized: true`; Node's
default hostname verification is retained. No existing bootstrap/preflight
connection helper or implicit `drizzle.config.ts` URL configuration is used.
Database notices and Drizzle query logging are disabled; failures print only a
trusted migration tag and an allowlisted error category, never raw driver errors.

**Unresolved:** this implementation did not connect to the endpoint, inspect
secrets, or verify its certificate. If its certificate does not cover
`shinkansen.proxy.rlwy.net`, the run must fail with `tls_certificate`. Obtain a
properly trusted certificate covering this exact endpoint before any separately
authorized run; do not override hostname checks or weaken TLS. Independently
verify backup/recovery, protected-environment approval, credentials, identity,
44-row history and schema/control prerequisites. Local mocked tests are not
staging execution or production readiness.

## Read-only Part 2 verdict

0065 and 0066 are journaled. Their creating commits `802527b` and `5787224`
are ancestors of main, merged via PR #70. Their messages describe 0065 as
owner-approved and 0066 as owner-requested/byte-identical to a reviewed script.
Both file headers still say draft; 0066 also incorrectly says not journaled.
PR #70 reports a hash/history query on a Lovable Cloud database but explicitly
does not identify it as the serving production target. The user-provided
Railway staging history has only 44 rows through 0043 (not independently queried
here). Git history indicates final intended SQL with stale comments, not proof
that either migration is applied to this staging database. Neither is modified
or exposed to this runner.

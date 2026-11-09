# Production recovery evidence gate (PR 60)

**Decision: BLOCKED pending provider and production records.** No production
connection is available to this audit. Evidence below from the PostgreSQL 17.11
rehearsal is dated local evidence, not live production configuration. Do not
enable CODE, release Emergency Stop or global pause, activate schedules, invoke
jobs or perform a production restore to collect evidence.

## Required provider records and accountable operators

Capture each record's source, UTC collection time, authenticated operator,
project/organization identity, and immutable ticket/export reference. Keep
credential-bearing exports in the owner's restricted evidence store, not Git.
An account-infrastructure operator must obtain the records from Lovable Cloud
or its underlying managed database provider; a source-file Supabase project
reference alone does not establish which provider/project serves production.

| Record | Exact required evidence | Responsible operator | Current status |
|---|---|---|---|
| Production binding | Authenticated provider project/resource ID, organization, region, database endpoint identity without userinfo/password, and Lovable production project/backend binding; timestamped live version commit/tree | Owner + Lovable/provider administrator | BLOCKED: no current authenticated binding |
| Backup identity | Provider backup ID; if provider supplies no ID, its canonical backup object/resource reference and provider support attestation; source project, backup type (physical/logical), successful completion status, start/end UTC and snapshot consistency point | Provider backup administrator | BLOCKED: not supplied |
| Artifact provenance/integrity | Provider checksum/verification report or explicit statement that no checksum is exposed; original artifact size/SHA-256 in restricted evidence, acquisition chain, exact filtering/exclusion manifest and filtered artifact checksum; successful isolated restore report | Backup custodian + DBA | BLOCKED: filtered restore success is not original-backup integrity proof |
| PITR protection | Actual enabled/disabled state, configured retention, earliest/latest restorable UTC points at capture, base-backup/WAL continuity/verification status, provider incident/gap status | Provider backup administrator | BLOCKED: plan entitlement/default retention is not evidence |
| Chosen recovery point | Owner-approved target UTC within the actual window, backup/WAL references, achieved restored point/provider completion record, safe business marker/consistency proof and measured data loss/downtime against approved RPO/RTO | Owner + recovery DBA | BLOCKED: no selected/achieved point record |
| Whole-service scope | Database, roles/memberships, extensions, storage objects versus metadata, auth/custom-role credential recovery, external configuration and exclusions inventory | Provider administrator + application owner | BLOCKED: filtered SQL is not whole-service recovery |

Supabase documents authenticated **GET**
`/v1/projects/{project_ref}/database/backups` and its Dashboard Backups/PITR pages
as read-only inventory sources. An authorized operator may collect these through
their existing managed account. Do not create credentials in chat, run restore
POSTs, enable PITR or change retention as part of this audit. If Lovable owns the
provider relationship, request these fields through its authorized support path.
Missing fields require provider attestation, not invented identifiers.

Reference reviewed November 9, 2026:
<https://supabase.com/docs/guides/platform/backups>. Database backups exclude
Storage API object contents and omit custom-role passwords. PITR entitlement,
documented retention options and nominal WAL cadence do not prove this project's
actual recoverability. Recovery to a new project can incur costs and requires
separate owner approval.

## Excluded services: value-free verification

**Cron — DBA/platform scheduler operator.** Supply the exact excluded-job manifest,
schedule/timezone, enabled state, owner and required extension/version/dependencies
in restricted evidence. Compare command definitions privately against the approved
baseline; return only opaque job aliases, match booleans and review references.
Do not output command text: it can contain URLs, tokens or headers. Counts alone
cannot prove job identity. A provider-managed or database scheduler can execute
independently of Jackboy's UI: require a timestamped disabled/quiescent scheduler
record and disconnected workers. A separate approved isolated test may use fixed
inert diagnostics with no external network; never run recovered commands merely
to verify their presence. No scheduling mutation is authorized by this document.

**Two Realtime functions — provider Realtime maintainer + DBA.** First obtain their
exact schema, names, overloaded argument signatures and exclusion reasons from
the filtering manifest; their identities remain missing. Capture provider/Postgres/
Realtime versions and approved definitions, owner, SECURITY DEFINER/search_path,
ACLs, dependencies, publication/subscription and replication-slot requirements.
Compare catalog identities and definition hashes against an approved same-version
reference privately. Hashes identify definition differences, not safe behavior or
grant correctness. Existing functions/extension installation cannot substitute
for the two missing entries. A provider-supported isolated authorization/RLS
fixture test with synthetic tenants requires its own approved scope; no live
subscription, replication change or production RPC invocation here.

**Vault — provider key custodian + security owner.** Require the secret inventory
as opaque aliases/counts, key identifiers/versions and encryption-provider binding
in restricted evidence, key availability/rotation history, grants/owner fidelity,
and provider-approved recovery attestation. Do not query or print plaintext,
ciphertext, nonce, key material, connection strings or credential names. Do not
hash low-entropy secrets for publication. On a separately approved isolated
provider-native restore, the custodian may verify decryptability internally and
return only alias + success/failure + key-version match; never return decrypted
values. Consumer verification must use disconnected fixtures, not a live paid
request or job. Database encryption recovery does not prove external credentials
remain valid. The existing rehearsal restores zero Vault secret rows: only
schema/ownership/ACL recovery is proven.

## Authorized read-only production SQL pack

`scripts/code-production-evidence.sql` uses a repeatable-read, read-only transaction,
statement/lock timeouts and SELECT-only catalog/table reads. It invokes no Jackboy
RPC (including functions named status/refresh), scheduler command, decryptor,
secret view, session handshake or provider call. It does not change Stop settings.

The already-authorized DBA runs it through the provider-approved read-only session,
for example using an existing credential-managed libpq service:

```sh
psql -X 'service=owner-approved-readonly' -f scripts/code-production-evidence.sql
```

The service name is illustrative, not an instruction to create credentials.
Do not paste connection strings or credentials in chat or shell arguments.
Preserve the output in the restricted evidence store with target binding and
collection time. Do not enable statement echo, debug tracing or application logs
that might expose other queries.

Permission errors, absent expected relations, timeouts, an RLS-filtered reader,
unexpected database binding or incomplete output are **BLOCKED**, not empty
tables/zero work or absent migrations. The SQL rolls back on normal completion;
ON_ERROR_STOP causes psql to disconnect/abort on failure. Never grant privileges
to make this audit pass. A preauthorized provider DBA may export the same data
read-only if the restricted reader cannot see complete rows.

Interpretation:

- Database name/version/reader and replica flag must be joined to the provider
  binding record. A generic name `postgres` proves no project identity. Replica
  reads also need lag/freshness proof and cannot independently establish live
  zero active work.
- Compare the **complete** journal against approved repository hashes/timestamps.
  Row IDs are not migration numbers. `exact_rows=1`, conflicting rows=0 is the
  required per-entry identity, not proof of actual catalog implementation.
  Predeployment absence of 0059/0060 is pending work, not permission to install.
- Catalog evidence reports missing functions explicitly, function-definition MD5
  for same-version drift comparison, owner, SECURITY DEFINER, empty search_path
  and effective role execute privileges including inherited/PUBLIC grants.
  Definition hashes are not secret hashes or cryptographic backup integrity.
  Guardian's authenticated entrypoint still needs its internal owner check.
  Claim/readiness must reject anon/authenticated/PUBLIC and allow service_role.
- Acceptance trigger must name the expected table/function, enabled `O`,
  unconditional BEFORE INSERT ROW (`tgtype=7`), no arguments or constraint.
  Missing output is missing protection. Other guard/activation/audit trigger and
  function bodies must match reviewed definitions too; a correct name alone
  proves nothing.
- Require exactly one control row: enabled=false, kill_switch=true, no active
  request/run; global pause=true. Record cancellation confirmation and independent
  scheduler/GitHub/runner state. Zero `reserved` holds is required for 0060;
  investigate finished/unsettled holds without deleting/refunding accounting.
  Daily <=$5, cumulative <=$10 and acceptance-approved hold <=$1 must retain all
  metering/reservation checks. Stored hard-cap flags/freshness are not live
  provider enforcement proof. SQL observation does not exercise a paid run.
- Compare validated constraint definitions, grants and RLS, not just the count
  322. The pack covers selected safety surfaces, not a full ACL/default/column
  grant, owner/passkey, CODE_TARGETS, environment or autonomy audit. Obtain
  timestamped read-only application/provider evidence for those separate gates.

## Evidence-pack validation

The pack executed successfully against the original local filtered restore in
one read-only transaction. A separate disposable PostgreSQL 17.11 run then
executed it before 0059/0060 (missing functions) and after their installation;
both safety fingerprints remained unchanged. Migration failure rollback and
the existing spending/privilege assertions also passed; source unchanged and
container removed. Local evidence-pack/harness/history tests: **14 passed,
zero skipped**; focused ESLint and whitespace checks passed.

Repeat with:

```sh
node --test tests/code-production-evidence.test.mjs tests/code-recovery-harness.test.mjs tests/migration-history-reconcile.test.mjs
node scripts/rehearse-code-recovery.mjs
```

These are local results, not production output or new app-suite results.

## Evidence comparison and release checklist

### Synchronization repair: 0061 fixture identity

The sync source `lovable-sync-1794234102` at
`dcd14c522a650c86dcdcffbade0356c9b38c37ed` adds verification migration 0061.
Its SQL remains byte-identical (SHA-256
`a104a54f80beaed3de6ef2566d1f0cc42e7807b76581c4b42fbb2d9f5641263f`,
journal timestamp `1794234033152`). Authenticated production access is unavailable,
so installation/production ownership/privileges remain BLOCKED. The existing
read-only pack lists the complete journal and the relevant function owners and
effective privileges; the authorized DBA must compare the 0061 row with this
hash/timestamp. A commit label is not installation evidence.

The isolated acceptance/gateway clusters previously used `initdb -U stg`.
0061 rightly rejects functions owned by that role. Provisioning now uses
`initdb -U postgres` and the matching loopback connection inside the same
no-network namespace. This renames the disposable bootstrap identity; it adds
no grants and changes no production resources. No migration check, role assertion,
spending cap, test selector or no-skip enforcement is removed. Added tests pin
0061's bytes and prove rejection on owner/grant/trigger tampering.

The sync also broadened preview UUID matching beyond version-4/variant bits and
recognized `live--<uuid>[-thr_<id>]` as brokerable hosts. Editor-origin restrictions
remain, but more hostnames can select a project identity and enter session
get/set/remove brokerage. Repository code cannot establish the provider's
cross-project routing contract or approval for that wider authentication surface.
The change is therefore excluded: `previewAuthStorage.ts` is restored exactly to
main, with no claimed vulnerability fix or new auth scope. Generated RPC type
additions are retained with only their added lines formatted.

Rehearsal baseline: commit `24362dae4151145086212e889cab4e29c1e4e8b8`;
PostgreSQL 17.11, source image
`sha256:7bd84e6a1d5322c7b864b9751873a0ac50f48df3f20a776e88114eadb2948fc0`.
Two disconnected runs installed 0059 then 0060 as non-superuser `postgres`, proved
late failure rollback and source preservation, and ended stopped with $5/$10
limits. This was not a provider PITR or secret restore.

| Gate | Rehearsal evidence | Production record / operator | Decision |
|---|---|---|---|
| Candidate CI | Green at 24362dae: 907 app / 278 isolated acceptance, CodeQL | Exact future release SHA checks / repository owner | PASS for dated candidate only |
| 0059/0060 migration identity | Exact SQL/journal and rollback verified locally | Complete live journal + catalog pack / production DBA | BLOCKED: missing production output |
| Trigger/grants | Guard identity and service-only claim/readiness after install | Live definitions/effective grants/RLS / DBA + security owner | BLOCKED: missing |
| Stop, zero work, budgets | Disposable stopped, no active work; $1/$5/$10 probes | Timestamped controls/reservations plus independent workers/provider caps / DBA + app owner | BLOCKED: live state unverified |
| Backup/PITR/recovery point | Filtered local restore, not provider recovery | All backup/PITR records above / provider + backup custodian | BLOCKED: missing |
| Cron/Realtime/Vault completeness | Exclusions remain; Vault schema/ACL only | Exclusion manifests + supported recovery attestations / service maintainers | BLOCKED: missing |
| Approval | No production authority exercised | Separate migration and publication decisions / owner | BLOCKED: not requested/granted |

**Next owner action:** assign the provider administrator and production DBA to
collect the missing records and run the read-only pack through existing authorized
access. Do not release Stop or enable autonomy; if live controls are unsafe, stop
the audit and request a separately scoped owner-authorized safety intervention.
No migration, restore, publication, permission change or activation is authorized
by successful collection.

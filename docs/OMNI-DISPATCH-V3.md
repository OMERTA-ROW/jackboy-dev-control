# Jackboy scoped OMNI dispatch v3

V3 is an opt-in extension of the existing scoped dispatch lane. The v2 request,
callback, and client remain unchanged. V3 submits the exact owner-approved
instruction text (build patches or test instructions) with the existing ordered
`jackboy.dispatch-payload/v2` digest, and never accepts a caller-selected shell
command. Status and cancel requests contain only the original immutable scope.

The Jackboy sender and callback receiver both require the exact value
`JACKBOY_DISPATCH_V3_ENABLED=true`; unset, `false`, `TRUE`, and every other value
leave the v3 paths disabled. V3 submission revalidates the live owner grant
before signing and again before transport. Status and cancellation are limited
to a scope recorded by a previously authorized v3 submission, so cancellation
can still be signed after its grant expires or is revoked without authorizing
new work. Manual grant revocation, project revocation, owner diagnostics, and
owner-initiated handshake/link-loss checks reconcile revoked or expired v3 jobs
through signed cancellation when v3 is enabled.

Outgoing request JSON is limited to 8192 UTF-8 bytes, with payload strings
limited to 6144 UTF-8 bytes and expiry strictly future, no more than 30 minutes
ahead, and no later than the owner grant expiry. JSON escaping can make an
otherwise in-limit payload exceed the envelope limit; such requests are refused
before signing or transport. V3 callbacks are limited to 8192 bytes and bind
the exact historical job scope, including the payload digest. Completed and
failed callbacks require a strict result object; the summary is limited to 500
Unicode characters and output to 6144 UTF-8 bytes. Fresh-nonce retries for the
same job/status are idempotent, while any reused nonce is rejected. Callback
events, nonces, results, and immutable v3 scope are stored transactionally in
private service-role-only tables. Later running/quarantined events do not
replace a terminal state.

The new database migration is `0062_omni_dispatch_v3.sql`; it is not applied by
this change. Jackboy's sender configuration names are
`JACKBOY_DISPATCH_V3_ENABLED`, `OMNI_DISPATCH_ORIGIN`,
`OMNI_DISPATCH_CLIENT_ID`, and `OMNI_DISPATCH_HMAC_SECRET`.
`OMNI_DISPATCH_CA_FILE` is optional: when unset or empty, HTTPS uses Node's
normal trusted certificates (including standard Railway HTTPS). When set, the
file supplies the custom CA; file or TLS errors fail the request without
falling back to system trust. Certificate verification remains enabled.
The callback receiver additionally requires
`OMNI_DISPATCH_CALLBACK_CLIENT_ID` and `OMNI_DISPATCH_CALLBACK_SECRET`.
The OMNI inbox continues to require its own `OMNI_DISPATCH_ENABLED` gate and,
only for separately approved execution, `OMNI_WORKER_ENABLED`. These flags and
settings are not changed or enabled here. The v3 lane remains receipt-only if
the remote worker is off.

Before any separately approved rollout, apply the database migration through
the normal reviewed process (see the legacy reconciliation exception below),
provision separate matching managed secrets on
both services, verify the live OMNI receiver version and callback URL, and test
submission, status, cancellation, expiry, callback replay protection, and
revocation in an isolated environment. Do not treat a local test, callback
receipt, or deployed version as permission to enable dispatch or execution.

## Legacy Lovable schema reconciliation (operator review only)

**Nothing has been applied.** The owner reports an empty legacy
`public.omni_dispatch_v3_jobs` with `result_at` and `last_source`, but without
`kind`, `payload_digest`, or `expires_at`, plus the old
`omni_dispatch_v3_record` and `omni_dispatch_v3_callback_scope` functions.
This is not evidence that main's 0062 has been applied. Main at
`e76b7fe645be6141ff4d077a2549d919c242243a` includes merged #62
(`59b6179ff9ccbcd4b622e19cd6cb37db0328e883`) and #63; its 0062 is a
different migration from the earlier Lovable file with the same number.
No production database was accessed for this change. In a subsequent owner
verification supplied on 2026-11-10, the deployed source was identified as main
`e76b7fe` plus Lovable commits `d1b7b648e0b1ad2114da82fe9ff37eba04e2f597`
and `bc8a33712491992549ced8423a40ad1c73b16207`, changing only generated types
and `previewAuthStorage.ts`. The owner confirmed no deployed old RPC callers,
zero legacy rows and absence of the new 0062 tables. These are owner-supplied
observations, not live checks performed by this PR. Actual migration-manager
bookkeeping remains unverified.

`scripts/reconcile-omni-dispatch-v3.psql` and the self-contained SQL alternative
`scripts/reconcile-omni-dispatch-v3.sql` are **alternate entrypoints for 0062**,
not a 0063 migration or a post-failure cleanup. Each is
deliberately absent from `drizzle/migrations/meta/_journal.json`. It starts
one transaction, obtains `ACCESS EXCLUSIVE` on the legacy table, requires an
RLS-bypassing operator, checks emptiness under that lock, then renames:

| Existing object                                                                 | Preserved name                                                    |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `public.omni_dispatch_v3_jobs`                                                  | `omni_dispatch_v3_jobs_legacy_lovable`                            |
| `public.omni_dispatch_v3_record(text,text,uuid,uuid,uuid,uuid,text,text,jsonb)` | `omni_dispatch_v3_record_legacy_lovable` (same arguments)         |
| `public.omni_dispatch_v3_callback_scope(uuid,uuid,uuid)`                        | `omni_dispatch_v3_callback_scope_legacy_lovable` (same arguments) |

The psql entrypoint uses its file-relative `\ir` to execute **all of the unchanged
`drizzle/migrations/0062_omni_dispatch_v3.sql`**, and commits only when that
entire file succeeds. Its SHA-256 remains
`3d9e882b8cec18835456220c126d08d489037a61a5cc5bdf1b218bc06af3a3bf`.
The SQL alternative inlines the exact same transaction preflight/DO block and
0062 bytes, with automated equality checks against both source files; it has
no psql commands or external includes. The three new tables, callback-event identity
sequence, guard function/trigger, three RPCs, constraints, RLS and grants all
come from that exact file. An error anywhere, including a late function or
object collision in 0062, leaves the transaction aborted; no rename commits.
The transaction explicitly uses READ COMMITTED, so a connection configured for
repeatable reads cannot use an older snapshot for the post-lock emptiness check.
`ON_ERROR_STOP` ends noninteractive psql on failure. Lock acquisition times out
after five seconds; each statement times out after sixty seconds.

The wrapper accepts only the eleven legacy column names above (UUID identifiers,
text `repo`/`status`/`last_source`, JSONB `result`, timestamptz timestamps).
It rejects extra/dropped/generated/identity columns, inheritance/partitions,
missing or overloaded legacy functions, wrong signatures/return types,
extension-owned objects, suffix collisions and missing/incompatible prerequisites.
Signatures and column types are evidenced by checked-in historical Lovable
source, not guessed from production. Arguments are still obtained from
`pg_get_function_identity_arguments` and names are identifier-quoted when
renaming; neither old function body is replaced.

Table renames do not rename indexes. Only the two names needed by exact 0062
(`omni_dispatch_v3_jobs_pkey` and
`omni_dispatch_v3_jobs_grant_id_job_id_key`), if present and owned by the
legacy table, are also suffixed `_legacy_lovable`. Constraint-backed indexes
are renamed through their constraint; standalone indexes through `ALTER INDEX`.
Their OIDs and definitions survive. Other indexes, outgoing FKs, checks, RLS,
policies, owners and grants remain attached to the archived table unchanged.
Incoming FKs, user triggers, rules, dependent views/functions (including row-type
dependencies), owned sequences and unrelated objects occupying those index names
are refused, not dropped, disabled, redirected or automatically repaired. The
new callback sequence cannot replace an existing one. Reserved callback relation,
index, sequence and row/array-type names are checked before renaming: PostgreSQL
can otherwise silently choose a different identity/index name on a collision,
which would make 0062's exact sequence grant target the wrong sequence.

**The renamed functions are preserved for inspection, not a compatibility
bridge.** Their textual table references may resolve to the new table at the
original name. Do not execute them or redirect old callers to their suffixed
names. Catalog checks cannot discover all textual/dynamic SQL, remote clients,
or unpublished Lovable code. The exact deployed callers must be reviewed and
quiescent before a separately approved application.

### Correct standalone/apply sequence and bookkeeping

1. Independently identify the approved target and exact checkout, verify a
   restorable backup, and pause writers/migration runners through the owner's
   separately approved process. Read actual definitions, grants, dependencies,
   deployed source, and migration history without changing them. If the schema
   is already main's new shape, use neither this wrapper nor 0062 again. If it is
   nonempty, mixed, partially applied, or differs from the supported legacy
   shape, stop for a new reviewed plan.
2. Resolve **the actual migration manager's bookkeeping before any write**.
   The wrapper deliberately does not insert, update, delete, or invent journal
   records. The repository has no production apply command; its Drizzle journal
   lists 0062 at `when = 1794285308000`. The installed Drizzle migrator compares
   pending timestamps to the latest database entry and records the source SQL's
   hash after applying it, within its transaction. A later wrapper entry cannot
   fix an earlier failing 0062. Conversely, a legacy Lovable entry with the same
   number or a later timestamp can cause the canonical migration to be skipped.
   **Do not overwrite historical hashes/timestamps, mark unapplied SQL applied,
   or infer installation from a timestamp.** An operator must review the real
   manager's exact schema/history reconciliation and registration procedure.
   If it cannot record the canonical 0062 as fulfilled without rewriting
   history or replaying it, stop; no general journal-repair script is supplied.
3. For an explicitly approved **standalone schema-only** operation, choose
   **one** reviewed entrypoint, **instead of** running 0062 directly. Neither
   entrypoint is idempotent or safe to rerun.

   **psql route:** use a fresh connection with the reviewed psql wrapper.
   The following is an operator template, not an instruction executed here:

   ```sh
   psql -X --no-password --dbname='service=OWNER_APPROVED_TARGET' \
     --file=scripts/reconcile-omni-dispatch-v3.psql
   ```

   Configure verified target/TLS/credentials through the operator's secure
   service configuration. Do not paste this psql file into a SQL editor:
   `\ir` is a psql command. Do not use `--single-transaction`, an enclosing
   `BEGIN`, an unattended migration runner, or execute only the renames.

   **Lovable Cloud SQL runner route (no psql required):** use the entire
   `scripts/reconcile-omni-dispatch-v3.sql` file unchanged. It already contains
   the checks, locks, renames and all of original 0062 in **one BEGIN/COMMIT**,
   with explicit READ COMMITTED isolation. The runner must execute the
   **whole file in a single fresh session**, preserve its transaction statements
   and stop on any error, rolling back the whole transaction. Do not select
   individual statements, run statements independently, add an enclosing
   transaction, or strip transaction statements. Verify/rehearse the runner's
   transaction and error behavior independently before approval; if it cannot
   guarantee these requirements, stop. This file is not proof that Lovable's
   runner meets them. The same backup, quiescent-writer, flags-off, operator
   approval and bookkeeping requirements above apply to both routes.

4. On failure, stop and inspect read-only; a fresh noninteractive psql connection
   rolls back the aborted transaction when it exits. A SQL runner must likewise
   roll back on error, not continue with independent statements. On uncertain connection
   loss, verify actual state rather than retrying. On success, verify the archived
   OIDs/definitions/grants/policies and all canonical objects read-only. Complete
   only the previously approved manager-specific bookkeeping. **Do not resume a
   normal migrator while 0062 is still pending, and never run original 0062
   again after the wrapper**, which already executed it. Leave all settings,
   dispatch, execution, deployment and merge gates unchanged.

### Recording an already-applied 0062 (Lovable SQL runner)

If 0062 was applied through `scripts/reconcile-omni-dispatch-v3.sql` and Drizzle
history still lists it as unapplied, run the whole
`scripts/record-omni-dispatch-v3-0062-history.sql` once in a fresh session (one
BEGIN/COMMIT, no psql commands). It inserts the canonical 0062 row (sha256 of the
checked-in file, journal `when` 1794285308000) only if the hash is absent, no
history row is at or after that timestamp, and the three tables, their
12-column jobs shape, the four functions and the identity sequence exist;
otherwise it raises and rolls back. It also runs
`REVOKE ALL ON SEQUENCE public.omni_dispatch_v3_callback_events_id_seq FROM PUBLIC, anon, authenticated`.
It never reruns 0062 or rewrites existing history, and is not a migration.
Merging this file does not execute it; running it needs separate owner approval.

### Checked-in legacy caller inventory (2026-11-10)

Full tracked-tree searches on main `e76b7fe` found **no old function callers or
declarations**, including `src/integrations/`, `.lovable/`, `supabase/`, tests
and migrations. Read-only remote-ref discovery found newer Lovable source not
initially present locally. Searches included those fetched refs and reachable
Git history; they do not prove the absence of unpublished or deployed callers.

The following paths/lines are relative to the **pinned historical refs**, not
this PR's runtime tree:

| Source ref / commit                                                    | Exact files and lines                                                                                                                                                                       | Classification                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `lovable-sync-1794272803` / `8312c3e39f2ea8e0eca7007c0a7840665277d660` | `src/lib/omni-dispatch-callback.server.ts:67` (`callback_scope`), `:103` (`record`); `src/lib/omni-dispatch-execute.server.ts:141` (`record`)                                               | Actual old RPC callers                                                           |
| same `8312c3e`                                                         | `src/lib/omni-dispatch-callback-v3.test.ts:69,80,103,110,191,205`; `src/lib/omni-dispatch-execute-v3.test.ts:111`; `tests/omni-dispatch-v3-record.test.mjs:39,133,140,144,183`              | Tests/mocks, SQL invocations and privilege checks                                |
| same `8312c3e`                                                         | `drizzle/migrations/0062_omni_dispatch_v3.sql:26,107-108`; `0063_omni_dispatch_v3_late_updates.sql:3,85-86`; `0064_omni_dispatch_v3_late_results.sql:9,27-30,125-126`                       | Definitions/grants, not runtime callers                                          |
| same `8312c3e`                                                         | `src/integrations/supabase/types.ts:3760,3764`; `src/lib/AGENTS.md:43`                                                                                                                      | Generated declarations / feature documentation, not callers                      |
| `lovable-sync-1794272067` / `159923de8d357e07eb7076133aa7ffea6935fd8f` | `src/lib/omni-dispatch-callback.server.ts:85`; `src/lib/omni-dispatch-execute.server.ts:141`                                                                                                | Earlier `record` callers; no `callback_scope` yet                                |
| same `159923de`                                                        | `src/lib/omni-dispatch-callback-v3.test.ts:102`; `src/lib/omni-dispatch-execute-v3.test.ts:111`; `tests/omni-dispatch-v3-record.test.mjs:34,129`; `src/integrations/supabase/types.ts:3760` | Earlier test/privilege references and generated `record` declaration             |
| `lovable-sync-1794290580` / `bc8a33712491992549ced8423a40ad1c73b16207` | `src/integrations/supabase/types.ts:3760,3764`                                                                                                                                              | Generated old declarations only; no old runtime callers in this tracked snapshot |
| `lovable-sync-1794241273` / `a4884b8255e950700fba5612106a564e11fa2fbd` | No matches                                                                                                                                                                                  | No old declarations/callers in this tracked snapshot                             |

The test fixture preserves exact historical table/policy statements from
`8312c3e`'s 0062 lines 4-24 and final function statements from its 0064 lines
9-126. This PR does not import historical callers or change
`previewAuthStorage.ts`. The subsequent owner-supplied deployment verification
above establishes that the listed historical callers are not deployed; the
agent has not independently queried the live Lovable source. Actual migration
bookkeeping still requires separate owner/operator verification. Local tests
and historical snapshots do not establish production readiness.

### Post-reconciliation generated types

The owner separately requested regeneration of `src/integrations/supabase/types.ts`.
The installed official Supabase CLI generated types from a disposable native
PostgreSQL database, listening only on `127.0.0.1:56432`, populated with
`tests/fixtures/omni-dispatch-v3-prerequisites.sql`, the historical fixture, then
the **actual psql wrapper**, including canonical 0062. No production URL,
credentials, schema reads, migrations, linked-project target or remote provider
API were used.

The generation command was:

```sh
supabase gen types --lang=typescript --schema=public \
  --remote='postgresql://postgres@127.0.0.1:56432/postgres?sslmode=disable'
```

Here `--remote` is the CLI's direct-URL syntax, targeting **only that disposable
loopback server**. Plaintext is appropriate only for this synthetic loopback
test; do not transfer `sslmode=disable` to a real service.

Only the four `omni_dispatch_v3_*` table entries and five RPC entries were
transferred from this generated output, in the existing file's style. The
unrelated generated schema and internal PostgREST version are unchanged; this
is a scoped regeneration, not a claim that the entire live schema was
regenerated. It includes the suffixed legacy table/functions for catalog
accuracy, not as permission or encouragement to call them. The generator omits
the trigger-returning guard function from callable RPC types.

The archived outgoing FK names stay unchanged. PostgreSQL therefore names the
new jobs table's grant/job FKs `omni_dispatch_v3_jobs_grant_id_fkey1` and
`omni_dispatch_v3_jobs_job_id_fkey1` in this reconciliation; the regenerated
relationships reflect those actual catalog names rather than assuming a fresh
installation's names. Tests compare all four tables' Row/Insert/Update fields,
nullability, defaults, identity insert/update restrictions, FK names/targets/
cardinality and all five RPC signatures directly with the isolated reconciled
catalog. Apply the migration before relying on these post-migration types;
their presence does not prove installation or confer database access.

The reconciliation suite is named
`tests/code-omni-dispatch-v3-reconciliation.test.mjs` so the existing Verify
workflow's `tests/code-*.test.mjs` selector runs it without a workflow change.
Both entrypoints run the same synthetic success, fail-closed, RLS,
non-rerunnable and atomic-rollback cases. Tests compare their complete public
catalogs: relation/column definitions and defaults, constraints, indexes,
function bodies, triggers, RLS policies, owners/grants and sequence definitions/
ownership, including archived legacy objects. These isolated checks establish
schema equivalence, not production readiness or live runner compatibility.
Native validation also compared complete schema-only dumps after the actual
psql wrapper and a whole-file SQL request; both routes passed nonempty,
late-error rollback and concurrent-writer checks on disposable local fixtures.
Local validation also used the actual wrapper in disposable native PostgreSQL
via psql, and a concurrent uncommitted insert: the wrapper waited on the lock,
then rejected the newly committed row without renaming anything, even with a
database default of REPEATABLE READ. No test contacted a real service.

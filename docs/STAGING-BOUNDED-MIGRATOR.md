# Railway private-network staging migrator

This is a code-only proposal for a dedicated, one-shot Railway container. It
does not provide an HTTP server or public endpoint. A GitHub-hosted workflow
cannot resolve Railway private DNS, and `railway run` executes locally rather
than inside Railway's private network; neither is used here.

**Nothing was deployed or connected to a database.** No migration was run.
**Applying 0044–0064 is hard-disabled.** The known 0044/0030 collision means
these files must not be applied as-is. The write implementation has been removed;
both former programmatic apply entrypoints unconditionally reject, and CLI
`apply` rejects before connection configuration or client creation, regardless
of environment flags or the former confirmation phrase. A revised, reviewed SQL
plan requires a code change and separate user approval; no runtime override exists.
This container must be manually configured and separately authorized before
any future execution. Do not attach a public domain, link production resources,
or enable automatic deploys/restarts.

## Railway service boundary

`staging/bounded-migrator/Dockerfile` is the container entrypoint;
`staging/bounded-migrator/railway.json` selects it, one replica and
`restartPolicyType: NEVER`. The image has no listener, `EXPOSE`, web server or
health endpoint. Its default mode is read-only inspection. The image build
stage copies only migration journal entries 0000–0064 into the final image;
later SQL is not present there. At runtime, 0044–0064 must also match the
reviewed SHA-256 pins in `scripts/staging-bounded-migrate.mjs`.

Railway's automatic-deploy and domain settings are platform controls not
expressed by this config file. Before creating or running a separate service,
an owner must select the `staging/bounded-migrator/railway.json` config path,
disable auto-deploy, ensure no public networking/domain is configured, attach
only the existing Jackboy staging Postgres service on its private network, and
verify the service environment is exactly staging. Keep the runner service
separate from the Postgres service. Those settings were not inspected, created
or changed here.

The runner accepts only Railway's exact staging environment ID
`83515d1e-141f-4fd1-8dfb-50764a73a5db`, `main`, the image's exact
`RAILWAY_GIT_REPO_OWNER=OMERTA-ROW`, `RAILWAY_GIT_REPO_NAME=jackboy-dev-control`,
and `RAILWAY_GIT_COMMIT_SHA` echoed by `STAGING_MIGRATOR_APPROVED_COMMIT`, plus
a distinct runner service ID. These Railway-provided Git variables require a
GitHub-triggered deployment. The live database marker must independently match
that environment and Postgres service ID
`f0c879d1-1934-4b5b-b4e6-728bc807d51d`; it is never created or repaired.

Provide only `RAILWAY_PRIVATE_DB_URL` and base64 PEM `RAILWAY_DB_CA_CERT` as
private service variables. The URL must use a `.railway.internal` hostname,
port 5432, and database `railway`; the public proxy hostname/port, any non-
Railway hostname, URL query or fragment are rejected. The database identity
marker—not the host string alone—binds the private connection to the pinned
staging environment and Postgres service.

TLS always uses the supplied CA with `rejectUnauthorized: true` and Node's
normal hostname verification for the complete private hostname. No callback,
hostname exception or TLS downgrade is installed. If the certificate does not
cover the actual private hostname, the runner fails closed; obtain an
appropriate CA-signed certificate before any separately approved run.

## Modes and one-shot gate

`STAGING_MIGRATOR_MODE` defaults to `inspect`; unknown values fail closed.
Inspection starts a PostgreSQL repeatable-read `READ ONLY` transaction and verifies exact database
identity before collecting metadata. It checks the 44-row baseline history
through 0043, seed availability and stopped CODE controls as separate diagnostics,
and prints a concise status summary with a sorted
catalog inventory. The inventory includes non-system schemas, tables and views,
column types/nullability, routine signatures, trigger table/event metadata,
table RLS flags, and policy command/permissiveness/roles. Columns are paginated
in 200-row pages within the consistent snapshot, up to 10,000 columns; exceeding
that safety ceiling fails with `catalog_column_limit_exceeded` instead of emitting
an incomplete inventory. Other categories are limited to 200 entries and report
whether they were truncated. It excludes view
and function bodies, policy expressions, table rows, and raw query results;
catalog names and type metadata are validated before output. It never calls
Drizzle's migrator.

History/seed/control mismatches do not suppress the inventory. Missing diagnostic
tables or columns are reported as unavailable; each diagnostic uses a savepoint
so PostgreSQL query errors do not poison the read-only transaction. Identity,
TLS, authentication, connection, permission and unexpected errors remain fatal,
not successful inspection. A diagnostic match never authorizes applying SQL.

## Drizzle history and guards

The image preserves the original 65-entry journal prefix through
`0064_omni_configuration_probe` for local hash comparison only. No Drizzle
migrator is imported by the executable runner and no SQL file is executed.
History diagnostics compare at most 66 rows against the expected 44-row prefix,
including original IDs, timestamps and hashes. The seed diagnostic checks
`omni`, `jax`, `razul`, `iggy` and any existing `chat_contexts` table. The
control diagnostic checks disabled CODE, engaged Emergency Stop, no active
request/run, `$1/$5` limits, paused automation and no reserved holds, using the
0043 schema definitions. It does not depend on the total limit added in 0046.
These checks describe drift, not permission to repair it.

Statements have explicit timeouts; the container also has an
overall execution deadline. Query/notice logging is disabled. Failures report
only a trusted migration tag and allowlisted category, never raw driver
messages, URL, password, CA or query data.

## Readiness and validation status

Docker build was not verified locally because the local Docker daemon was
unavailable. `.github/workflows/staging-inspector-image.yml` builds the image
on matching pull requests and main pushes without starting a container, accessing
environment secrets, pushing an image, or deploying. Its build result is not
proof of private DNS, TLS or database reachability.

No endpoint certificate, Railway environment configuration, secret, target
database, backup, live identity marker or migration history was inspected.
Before any separately authorized deployment/run, verify all of those
prerequisites and the new service's private-only, no-auto-deploy/no-restart
settings. Local mocked transport and PGlite tests are not staging execution or
production readiness. This change does not authorize creating the service,
connecting to staging, executing migrations, deployment or merge.

## Read-only Part 2 verdict

0065 and 0066 are journaled. Their creating commits `802527b` and `5787224`
are ancestors of main, merged via PR #70. Their commit messages describe 0065
as owner-approved and 0066 as owner-requested/byte-identical to a reviewed
script, while both migration headers still say draft; 0066 also incorrectly
says not journaled. PR #70 reports a hash/history query on a Lovable Cloud
database but does not identify it as the serving production target.
User-provided Railway staging history has only 44 rows through 0043; this was
not independently queried here. Git history indicates final intended SQL with
stale comments, not proof it is applied to this staging database. Neither
migration is modified or included in the container.

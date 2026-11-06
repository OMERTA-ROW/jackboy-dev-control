# Staging CODE schema bootstrap (draft; do not run)

This draft prepares a manual, main-only workflow for one fresh staging database.
It is **not authorization to run it**. Review, verify the exact merged commit and
target independently, and obtain a new owner approval for that commit and target
before dispatch. Never target production, copy production credentials or data,
enable CODE, activate schedules, or make paid calls.

The existing preflight found no CODE controls, not a compatible Supabase
installation. The workflow requires existing `auth.users`, `auth.uid()`,
`storage.objects`, and the `anon`, `authenticated`, and `service_role` roles.
It checks selected required columns, storage RLS and the service role's RLS
bypass attribute. The optional stand-in mode is described below. Their presence does not
prove that authentication, authorization, RLS or storage are correctly managed;
independently establish compatibility and credential scope before use. The
bootstrap refuses an existing Drizzle schema or user-created public tables,
functions and types. It is not a general-purpose migration runner or repair tool.

One transaction applies the explicit historical migration list through 0038,
including the unjournaled 0030 baseline required by 0031, followed by the CODE
reservation, hold-release and gateway migrations (journaled as 0041–0043).
It checks that the later journaled duplicate SQL copies are equivalent before
recording the corresponding Drizzle journal entries. It creates a restricted
staging marker, then applies the reviewed #35 gate migration. CODE stays disabled,
Emergency Stop engaged, the cap flag false, the automation policy paused, and
the $5 limit unchanged. This is
not a full current application schema: later or unjournaled application changes
are outside this bootstrap and require separate review. Do not start the app
against this partially provisioned database.

The marker is an operator assertion, not independent proof of Railway identity.
URL host/port/database matching and pinned `verify-ca` validate neither the TLS
hostname nor Railway environment/service identity, nor credential isolation.
Independently verify all of those and the disposable database, its current
contents, environment protection, privileges and recovery plan. Confirm that
the database is quiescent; the advisory lock serializes only bootstrap copies,
not unrelated database clients. Confirm the
`staging` GitHub environment has the intended protections before use; this file
does not configure them. A false attestation or shared CA can defeat these
interlocks. Never use CA-only verification for production.

The workflow requires the exact approved main SHA and a staging attestation, but
neither input grants approval by itself. GitHub secrets are read only inside the
manual job; no credentials are printed. A failed or interrupted connection can
leave commit outcome uncertain; inspect the target read-only before any retry.
Successful bootstrap is not a live safety or integration check. Separately
approved staging-only credential, authorization, audit, Emergency Stop and
rollback checks remain necessary. #35 rollback restores the original 0037
constraint but does not undo the application schema.

## Optional disposable-cluster stand-ins

The `create-disposable-standins` input creates minimal `auth` and `storage`
schemas and three NOLOGIN roles in the same transaction as the bootstrap.
It refuses to proceed if either schema or any named role already exists; it
never modifies or reuses pre-existing roles. PostgreSQL roles are **cluster-wide**,
and `service_role` has BYPASSRLS. A successful commit persists those roles for
every database on the cluster. Independently establish that the entire cluster
is dedicated to disposable staging, that no credentials or other databases can
assume those roles, and that role creation is authorized before any dispatch.
The database user may lack the privileges needed to create BYPASSRLS roles; the
bootstrap will fail and roll back rather than weaken that requirement.

These are inert test scaffolds, not a Supabase deployment. `auth.uid()` always
returns NULL: no one can sign in through these stubs, and they cannot validate
JWTs, sessions, invitations, real credential isolation, managed API behavior,
passkeys, object storage, or realistic RLS authorization. They create no
login credentials, memberships, auth service, or storage service. Do not start
the application or expose the database as an authentication backend.

The separate manual diagnostics workflow only reads catalog presence flags. It
does not prove cluster isolation, identity, authorization, privileges, database
emptiness, or readiness. Both workflows use the same pinned CA-only transport;
hostname identity remains unverified. A new approved commit and target are
required after review; no workflow is run by creating or merging this draft.

The separate `staging-environment-preflight.yml` workflow uses the protected
`staging` GitHub environment and its environment-scoped secrets. It reports an
absent, matching, or conflicting marker and catalog presence flags in a
read-only transaction. A conflicting marker fails the workflow. A fresh
database is expected to have no marker: bootstrap creates it. A matching marker
is still only an assertion, not independent identity evidence; absent or matching
does not establish that the database is empty or that bootstrap is safe.
Changing secrets after preflight invalidates its evidence. Merging this workflow
changes the main commit, so bootstrap requires a separate approval for that new
exact commit and target. Environment review remains required for each workflow.

# CODE staging gate migration (review only)

`staging/code-gate/001_up.sql` and `001_down.sql` are separate from every
production migration directory. The up migration removes the 0037 constraint
only after checking the owner-supplied staging environment/service marker and
requiring CODE disabled, Emergency Stop engaged, no active run, and the
verification flag false. It does **not** set the flag, enable CODE, change the
$5 daily limit, or grant access. Rollback requires those same stopped conditions,
the flag false, and no unsettled reservations. Both changes are atomic.

The staging database preflight found no CODE controls; it cannot yet run this
migration. A fresh database must first receive an independently reviewed,
compatible application schema and prerequisites, including Supabase-managed
roles and objects. Do not copy production data or credentials. The marker must
be provisioned independently by an authorized staging administrator **after**
verifying the Railway environment and service: a table
`public.jackboy_staging_identity(environment_id uuid, service_id uuid)` with
exactly one row containing the staging IDs in the SQL. This marker is a safety
interlock, not cryptographic or independent proof of target identity, and must
never be created in production.

The owner accepted pinned-CA-only TLS for staging writes. That verifies the
certificate chain but **not the hostname**; neither the CA-only preflight nor
the marker independently proves the Railway service or credential isolation.
Before any writes, independently verify the staging resource mapping, the
credential scope, backups/rollback and reviewed schema, and obtain separate
owner approval for the exact operation. Never use CA-only verification for
production. Do not apply these scripts via the normal migration runner.

Testing uses synthetic data and either in-memory PGlite or the existing
loopback-only disposable PostgreSQL harness. It does not prove a live passkey,
provider enforcement, cross-service budget, hosted auditing, or execution
readiness. No real provider calls, activation, or database writes are part of
this draft.

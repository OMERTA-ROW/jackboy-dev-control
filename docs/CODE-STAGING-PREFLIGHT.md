# Staging database preflight

The manually dispatched workflow performs a TLS-verified, read-only PostgreSQL
preflight. It compares the secret URL against the separately supplied expected
host, port and database, rejects URL options, and reports only whether the CODE
controls and 0037 constraint exist. The workflow runs only on `main`; no secret
is used on a pull request. It does not apply migrations or use a provider key.

The endpoint comparison is not independent proof of Railway project, service or
environment identity, and the secret is repository-scoped. The Railway owner
must separately verify the proxy maps to the specified isolated staging service
and that the credential cannot access production before any database writes.
Do not treat this preflight as approval to alter the 0037 constraint.

After review and merge, an authorized owner may manually run the workflow with
the exact non-secret staging hostname, port and database. Do not provide the URL,
username or password as inputs. Certificate verification is mandatory; a TLS
failure is a blocker, not a reason to disable validation. This preflight does not
perform credential-scope, application authorization, audit, Emergency Stop,
rollback, or live-provider tests.

On failure, the script prints only a fixed category, never the URL, raw error,
username or password. Categories distinguish malformed or unexpected URL
options, target mismatch, database mismatch, selected TLS certificate errors,
authentication errors and selected connection errors. Unrecognized errors are
reported as `unclassified`; these categories are diagnostic hints, not proof of
the cause. A successful preflight still does not establish Railway identity.

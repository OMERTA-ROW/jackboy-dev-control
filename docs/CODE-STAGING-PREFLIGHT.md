# Staging database preflight

The manually dispatched workflow performs a CA-verified, read-only PostgreSQL
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
username or password as inputs. The owner supplies a single trusted PEM certificate
encoded as canonical single-line base64 in `STAGING_DB_CA_CERT`. The preflight
decodes it in memory without logging it; absent, malformed, or invalid certificates
fail closed. The connection
uses only that trust anchor and verifies certificate chains and validity, but
**does not verify the hostname** at the owner's explicit request for this
read-only preflight. Anyone with a valid certificate under that CA could impersonate
the target. Input matching does not authenticate the endpoint or independently
establish Railway environment or service identity. Do not use this mode for
database writes. A TLS failure is a blocker, not a reason to disable chain
verification. This preflight does not
perform credential-scope, application authorization, audit, Emergency Stop,
rollback, or live-provider tests.

On failure, the script prints only a fixed category, never the URL, raw error,
username or password. Categories distinguish malformed or unexpected URL
options, target mismatch, database mismatch, selected TLS certificate errors,
authentication errors and selected connection errors. Unrecognized errors are
reported as `unclassified`; these categories are diagnostic hints, not proof of
the cause. A successful preflight still does not establish Railway identity.

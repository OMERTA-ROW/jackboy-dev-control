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
bypass attribute, but does not create simulated managed services or roles.
Their presence does not
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

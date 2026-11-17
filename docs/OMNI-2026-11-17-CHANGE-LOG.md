# OMNI change log, 2026-11-16 to 2026-11-17 (staging executor acceptance)

Everything changed while getting the isolated autonomous executor through its first staging acceptance
test. The step-by-step run and fixes are in `OMNI-STAGING-EXECUTOR-ACCEPTANCE.md`. This file lists what
changed and where. No secrets, hostnames or IDs belong here.

## Development changes (code)

| Repo | PR / commit | Change |
| --- | --- | --- |
| Mothership | #16 | Executor permission calls get a 6 second window; reviewed release bumped to `omni-bounded-plan-2`. Interop fixtures aligned with idempotent handshakes; lint formatting fixed. |
| Jackboy Dev Control | #79 | Accepts executor release `omni-bounded-plan-2`; isolated acceptance Mothership pin updated. |
| Jackboy Dev Control | #80 | Executor-control 401 responses name the failing check, only while `OMNI_AUTH_REASON_DEBUG=true`. Default response unchanged. |
| Jackboy Dev Control | #81 | Executor-control 503 responses name the failing stage and a masked, truncated error text, only while `OMNI_AUTH_REASON_DEBUG=true`. Default response unchanged. |
| Both | docs PRs | Staging acceptance runbook and troubleshooting blueprint; this change log. |

Tests added: one for the 401 reason codes and one for the 503 stage reason and masking, each checking that
the plain response is returned when the flag is off.

## Troubleshooting changes (operations, no code)

- Executor client ID on the staging host corrected to match Mothership and Jackboy. It had been copied from
  the wrong Railway service. All three now share one value; the executor service was restarted to load it.
- Jackboy link approval renewed (passkey) after a 403 `approval_expired_or_link_disabled`.
- Step 9 live link, Step 8 self-test and Step 10 authorization completed after the values matched.
- `OMNI_AUTH_REASON_DEBUG` set in Jackboy to read the failure reasons, then removed and republished.
- Diagnostic script and old env backups deleted from the staging host after use.

## Hosting and platform side

- Lovable (Jackboy): secrets changed and published by the owner (client ID, debug flag set then removed).
  Lovable secrets only reach the live app after Publish.
- Railway (Mothership): reviewed release setting `OMNI_AUTONOMY_REVIEWED_RELEASE=omni-bounded-plan-2`.
  Railway variable changes are staged and need a Deploy.
- Staging host (Vultr): plan-2 executor code, corrected client ID, execution lock on (disarmed) after the test.

## State at the end of the run

Execution off, executor disarmed, Jackboy authorization revoked, production off. The Railway staging
service `omni-autonomous-executor` is still an open pause-or-delete decision.

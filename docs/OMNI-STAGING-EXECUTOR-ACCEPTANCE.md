# OMNI staging executor acceptance: runbook and troubleshooting blueprint

Written 2026-11-17 after the first staging acceptance run. It records what was done, in order, and how to
fix each failure we hit. It applies to both repos (Mothership and Jackboy Dev Control); the same file is
kept in each. No secrets, hostnames or IDs belong in this file.

## Rules that always apply

- Production stays off until its own plan passes. This runbook covers staging only.
- Every change (deploy, publish, restart, enable execution, database access, merge) needs the owner's
  exact approval for that step. A bare "yes" is not approval.
- Secrets are never pasted into chat or screenshots. New secrets are shown only on the owner's own
  terminal. Anything that leaks is treated as exposed and rotated.
- Authenticator codes and passkeys are entered only by the owner.
- Execution is off by default: executor lock on, disarmed, no Jackboy authorization.

## Result of the first run

One approved `/usr/bin/printf` job ran on the staging executor, the permit was released, and the cost was
$0. The Stop drill was then done (disarm, revoke, lock restored) and the debug flag removed.

## Step by step

1. Check the three systems agree on shared values (see "Values that must match").
2. Staging executor host: plan-2 executor code, isolation files verified, lock on, disarmed.
3. Jackboy: save a link approval (passkey) in the "OMNI link values for Railway" panel.
4. Mothership: Step 9 live signed link, then confirm Jackboy's Step 8 self-test is green.
5. Mothership: press Verify executor. Jackboy only counts a verify for 15 minutes.
6. Mothership: tick only Step 10 (autonomy authorization), enter a fresh authenticator code, Activate.
7. Jackboy authorization: leave CODE jobs unticked unless CODE is in scope.
8. Tick only "Arm bounded executor". Plans are accepted only within 15 minutes of the last verify.
9. Run one harmless plan: `[{"argv":["/usr/bin/printf","omni-staging-ok"],"timeoutMs":1000}]`.
10. Confirm the job completed and the permit is released (0 active permits).
11. Stop drill: Disarm autonomy in Mothership, Revoke in Jackboy (passkey), set
    `OMNI_AUTONOMOUS_ENABLED=false` in the executor env file and restart the executor service.
12. Cleanup: remove debug flags, delete diagnostic scripts and env backups on the host.

## Values that must match

| Value | Where it must be identical |
| --- | --- |
| `OMNI_LINK_CLIENT_ID` | Mothership service, Jackboy, executor host |
| `OMNI_LINK_PROJECT_ID` | Mothership, Jackboy |
| `OMNI_LINK_HMAC_SECRET`, `OMNI_LINK_BOOTSTRAP_KEY` | Mothership, Jackboy |
| `OMNI_EXECUTOR_PERMISSION_SECRET`, `OMNI_EXECUTOR_PERMISSION_TOKEN` | executor host, Jackboy only |
| `OMNI_EXECUTOR_CONTROL_SECRET` | Mothership, executor host |
| `OMNI_AUTONOMY_REVIEWED_RELEASE` | all three (`omni-bounded-plan-2`) |

Not shared: `OMNI_API_KEY`, `OMNI_CALLBACK_SECRET`, `OMNI_LINK_AUDIT_DIR`, `OMNI_ALLOWED_REPOS`.
Compare lengths, never values, when checking.

## Troubleshooting blueprint

| Symptom | Cause we found | Fix |
| --- | --- | --- |
| Executor permission requests rejected, 401 `authentication_failed` | Client ID on the executor host did not match Jackboy and Mothership. It had been copied from a different Railway service (the one named "Omni", not the Mothership service). | Copy the client ID only from the Mothership service, set the same value everywhere, restart the executor. |
| 403 `approval_expired_or_link_disabled` | Jackboy link approval expired or the link switch was off. | Save a new link approval in Jackboy (passkey). Credentials were already fine at this point. |
| Step 10 fails with 503 `execution_control_unavailable`, Step 8 red, passkey button grey | Step 8 self-test proof was missing for the current approval after the earlier failures. | Renew the link approval, redo Step 9 once, confirm Step 8 green, Verify executor, then Step 10. Do not redo Step 9 repeatedly: it resets the Step 8 proof. |
| Step 10 checkbox or Activate unavailable | Jackboy's verify older than 15 minutes. | Press Verify executor, then retry within 15 minutes. |
| Lovable secret change has no effect | Lovable secrets reach the live app only after Publish. | Publish, wait about two minutes. |
| Railway variable change has no effect | Variables are staged. | Deploy (owner approval). |
| "Early activation is unresolved" blocks revoke | An earlier activation was never reconciled. | Use "Reconcile pending activation" with a fresh authenticator code (owner only). |
| Terminal paste misbehaves | `read -rs` swallowed following lines, or prompt text was pasted back in. | Paste short, one command at a time. Never paste prompt text or use `exit` in a pasted block. |

### How to find a 401 or 503 cause

Jackboy's executor-control endpoint can name the failing check, but only while the Jackboy secret
`OMNI_AUTH_REASON_DEBUG=true` is set and published. 401 reasons: `secret_missing_or_short`,
`token_not_configured`, `owner_id_invalid`, `client_mismatch`, `project_mismatch`, `token_mismatch`,
`signature_mismatch`. 503 reasons start with the stage (`nonce`, `approval`, `verify`, `readiness`,
`inspect`, `store`) followed by a masked error text. Switch the flag off again as soon as the cause is
found, then Publish.

## Lessons to carry into production

- Run a values pre-flight (lengths and match checks) before any activation attempt.
- Add the executor permission credentials and client ID to Jackboy's readiness check; today the panel
  does not validate them.
- Add executor-side error logging so failures show a reason without a debug flag.
- Production needs its own host, secrets, link approval, handshake, database backup and Stop drill.

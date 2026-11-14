# Jackboy execution permit — contract for OMNI / Mothership (`omni.permit/v1`)

Jackboy Dev Control is the final permission and Emergency Stop gate for OMNI autonomous and CODE
execution. A Mothership Step 10 approval is necessary but never sufficient: OMNI may run an
autonomous or CODE job **only while it holds a fresh Jackboy permit**.

Status: Jackboy side implemented and its database part installed on production as migration
`0066_omni_execution_permits` (2026-11-14 03:06 UTC, history row 73, byte-identical to the reviewed
`scripts/omni-execution-permit-draft.sql`). Permit and safety requests still need a live Step 9
session; handshakes are refused while the System Kill Switch is on. Any store error still returns
`503 permit_service_unavailable` (fail closed). The Mothership side lives in that project.

## Transport

Same endpoint and signing as `omni.link/v2`: `POST https://<jackboy>/api/public/omni/link`,
headers `Authorization: Bearer <session token from the Step 9 handshake>`, `X-Omni-Client`,
`X-Omni-Timestamp` (±60 s), `X-Omni-Nonce` (32 hex, single use), `X-Omni-Signature`
(`HMAC-SHA256(OMNI_LINK_HMAC_SECRET, "omni.link/v2\nPOST\n/api/public/omni/link\n<ts>\n<nonce>\n<sha256(token)>\n<body>")`).
The bootstrap key is refused for permit actions. Verify every response's `X-Omni-Proof`
(`HMAC(secret, "omni.link/v2\nresponse\n<nonce>\n<status>\n<body>")`) before trusting it.
Sessions last 5 minutes; re-handshake (requires Kill Switch off) to keep going.

## Actions (exact keys; anything else is refused)

| action | body keys | result |
|---|---|---|
| `safety` | `action, projectId` | `safety`: `{contract:"omni.safety/v1", checkedAt, validUntil (+30 s), killSwitch, emergencyStop, codeEnabled, authorization, autonomousAllowed, blockedBy, manualDiagnosticsAllowed, activePermits}` |
| `permit.request` | `action, projectId, jobId (uuid), kind ("autonomous"\|"code"), digest (sha256 hex of the job payload), estimateUsd (0 < x ≤ 1)` | `200 permit` (issue or renew) or `403 {error:"permit_denied", reason}` |
| `permit.release` | `action, projectId, jobId` | closes the permit when the job ends (idempotent) |

Active permit: `{contract:"omni.permit/v1", id, jobId, kind, digest, status:"active", issuedAt, expiresAt (≤ 60 s), renewals, limits:{perCallUsd:0.5, perTaskUsd:1, dailyUsd:5}, clientId, projectId, approvalId, renewEverySeconds:20, signature}`,
`signature = HMAC(secret, "omni.permit/v1\n<id>\n<jobId>\n<kind>\n<digest>\n<clientId>\n<projectId>\n<approvalId>\n<expiresAt>")`.

## OMNI obligations (required for the gate to mean anything)

1. Request a permit before starting any autonomous/CODE job; do not start without `200` + valid signature.
2. Renew every 20 s with the same `jobId/kind/digest`. If a renewal is refused, times out, Jackboy is
   unreachable, or the clock passes `expiresAt`: **halt and cancel the job immediately**. Never resume it;
   a lapsed or revoked job needs a new `jobId`.
3. Enforce the permit limits on every AI call ($0.50/call) and the job ($1). Jackboy reserves $1 per new
   job against a $5 UTC-day budget and allows one active job at a time; it cannot see OMNI's provider bill.
4. Treat a `safety` snapshot older than `validUntil` as stopped.
5. Manual terminal: owner-authorized sandboxed diagnostics stay independent of the CODE Emergency Stop,
   but are prohibited when `manualDiagnosticsAllowed` is false (System Kill Switch on).
6. Call `permit.release` when the job ends.

## Refusal reasons

`kill_switch_on`, `emergency_stop_engaged`, `code_disabled`, `not_authorized`, `approval_expired`,
`owner_scope`, `scope_invalid`, `scope_mismatch`, `job_closed`, `permit_lapsed`, `concurrency_limit`,
`daily_limit`; transport: `session_expired_or_invalid` (401), `replay` (409), `authentication_failed` (401).

## Jackboy guarantees

- Stopping (Emergency Stop engaged, Kill Switch on, or CODE turned off) revokes every active permit in
  the same database transaction; a failure there never blocks the stop, and every renewal re-checks.
- Owner authorization (OMNI page → "Authorize OMNI autonomous work with passkey") needs a fresh passkey,
  the Step 7 window, a passed Step 8 self-test for the current approval, a Step 9 signed handshake in the
  last 30 minutes, the runner, a trusted meter and the enforced spending guard. It lasts until the Step 7
  window ends and never releases a stop, changes a switch, starts a job or rotates a key.
- Nothing in Jackboy ever releases a stop, toggles an owner control, approves Step 9/10 or starts a job
  automatically.

## Step mapping

- Step 9 (Mothership): run the real signed `handshake`, then call `safety` and show the returned state.
- Step 10 (Mothership): after its own checks, call `safety`; it must show `authorization` present. Execution
  still requires `autonomousAllowed: true` and a permit per job.

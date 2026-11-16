# Mothership Step 10 "safety contract" failure: findings and fix plan

Read-only investigation. Nothing was changed. Times are UTC; your 04:00 AM Eastern is 09:00 UTC.

## 1. Endpoint, fields, signature
Both safety readings come in on one address, `POST /api/public/omni/link` (`src/routes/api/public/omni/link.ts` → `handleOmniLinkRequest` in `src/lib/omni-configuration.server.ts`). There are two kinds of reading:
- **Permit safety** (`action:"safety"`): `handleOmniPermit` in `src/lib/omni-permit.server.ts`, then the database function `omni_execution_permit_action('safety')`. The reply is `{contract:"omni.link/v2", requestNonce, http, safety:{contract:"omni.safety/v1", checkedAt, validUntil(+30s), killSwitch, emergencyStop, codeEnabled, authorization{...,capabilities}, autonomousAllowed, blockedBy, manualDiagnosticsAllowed, activePermits}}`.
- **Bounded-execution safety** (`action:"execution-control", audience:"mothership", operation:"safety"|connect|configure|verify|arm|disarm|unconfigure|revoke|authorize|lease`): `handleExecutionControl` in `src/lib/omni-execution.server.ts`, then the database function `omni_execution_control`. The reply is `{contract:"omni.link/v2", requestNonce, state:{...,executorOrigin}}`. If the approval or link is off, it forces `executionReady/allowed/connected=false`.
- **Signature (both):** header `X-Omni-Proof = HMAC-SHA256(OMNI_LINK_HMAC_SECRET, "omni.link/v2\nresponse\n<nonce>\n<status>\n<body>")`.
- **Error replies** (`plain()` 401/403/503) are bare `{error}` JSON with **no contract and no proof**. Mothership will always see those as "did not match the safety contract".
- **Where the contract is defined:** `SAFETY_CONTRACT`/`PERMIT_CONTRACT` in `src/lib/omni-permit.ts`, `LINK_CONTRACT` in `src/lib/omni-session.ts`, and the written spec in `docs/OMNI-PERMIT-CONTRACT.md` and `docs/OMNI-SECURE-LINK.md`. The check that actually failed runs inside Mothership (OMNI code). I could not read that code.

## 2. Which host serves it
- **The Lovable-hosted site** serves it. `/api/public/version` reports commit `4fc5677`, clean, built 08:05 UTC. The handshakes (site_log `omni.link.handshake` every minute, 08:55–09:00) and the `omni.execution.*` audit rows all land in this project's database.
- **The Railway service** runs in runner-only mode. It has no database and no link secrets, so it cannot answer either reading.
- **Code differences:** the reading code (`omni-permit*.ts`, `omni-execution.server.ts`, `omni-session*.ts`) is the same on GitHub main `3155b88`. Lovable-only commits touch only the 0075/0076 migrations, `code-safety.functions.ts` (Emergency Stop errors), its test and generated types. The difference that matters is in the **database**: 0076 is live here, and it affects the stop trigger, not the safety reply.

## 3. What fails right now
Mothership's own check isn't visible to me, so the cause below is the best supported diagnosis, not a confirmed one.
- **Most likely cause: the bounded-execution path can't be configured.** This project has no `OMNI_AUTONOMY_REVIEWED_RELEASE`, `OMNI_EXECUTOR_ORIGIN`, `OMNI_EXECUTOR_PERMISSION_SECRET` or `OMNI_EXECUTOR_PERMISSION_TOKEN` (names checked; values never read).
  - `configure` and `arm` therefore always return the bare `403 release_unreviewed`, or `503 execution_control_unavailable` when the executor check throws. Neither carries a proof.
  - The live connection row agrees: `connected=true, configured=false, armed=false, verified_at=null, executor_release=null`.
  - At 09:00:03 Mothership ran `unconfigure` (ok). No `configure`, `verify` or `arm` audit row exists after it, which fits a refusal before the database is reached.
- **Session limit (03:50 Eastern):** Mothership handshakes about every 60 s. Migration **0073 (idempotent handshakes) is not installed**: it was skipped along with 0071 and 0072, so sessions pile up until the 429. They have expired now, but this will happen again.
- **Permit authorization:** the owner authorization was saved at 08:47:06 (`omni.autonomy_authorized`, autonomous+code, expires 2026-11-17 03:49:58 UTC). That is only ~13 min before the 09:00 attempt, so earlier attempts had no authorization. The permit-path function adds `capabilities` correctly.
- **Current controls:** Kill Switch off, CODE **enabled**, Emergency Stop released (`cancellation_status=not_needed`), global pause off. You should know this state; I did not change it.
- **Ruled out:** no stale contract version and no missing permit-reply fields were found in the code. The meter/gateway guard would show up as `blockedBy`, not as a contract mismatch.

## 4. What must change

**(a) Database.** You approve each one; nothing releases a stop.
1. Install 0073 (idempotent handshakes) as a new forward entry. 0071–0073 are older than the latest history row, so the migration tool skips them. Needed to stop the session_limit 429s.
2. Optionally 0071 (denial diagnostics) and 0072 (nonce retention) the same way.

**(b) Code.** You approve; I prepare a draft PR to mirror.
1. Make every refusal on the link path (`plain()` in `omni-execution.server.ts` and `omni-permit.server.ts`) a signed reply: contract, `requestNonce`, `error` and `X-Omni-Proof`. Mothership then reports the real reason, such as `release_unreviewed`, instead of "contract mismatch". Refusals stay refusals; nothing gets unlocked.
2. Write one audit row for each refused execution-control call, recording the operation and reason (no secrets).
3. Tests for both changes.

**(c) Settings, publish and deploy.** You approve.
1. Add the four executor secrets (`OMNI_AUTONOMY_REVIEWED_RELEASE`, `OMNI_EXECUTOR_ORIGIN`, `OMNI_EXECUTOR_PERMISSION_SECRET`, `OMNI_EXECUTOR_PERMISSION_TOKEN`) with values matching the reviewed OMNI executor release. Only you can supply these; I never generate them.
2. Publish the Lovable site after (b).
3. Mirror the changes to GitHub main through a PR that you merge. Railway needs no change because it is runner-only.
4. OMNI side: Mothership should handshake once per 5-minute session instead of every minute. That needs the OMNI owner's approval.

## 5. On Lovable but missing from GitHub main (`3155b88`)
- `drizzle/migrations/0075_code_kill_switch_marker_check.sql`
- `drizzle/migrations/0076_omni_stop_trigger_where_armed.sql`
- `drizzle/migrations/meta/0075_snapshot.json`
- `drizzle/migrations/meta/0076_snapshot.json`
- `drizzle/migrations/meta/_journal.json` (entries 0075, 0076)
- `src/lib/code-safety.functions.ts` (Emergency Stop error detail)
- `src/lib/safety-controls.server.test.ts`
- `src/integrations/supabase/types.ts` (regenerated, from commit `f4462d3`)

## Verified vs assumed
- **Verified:** live version, DB rows and functions, secret names, code paths, missing 0071–0073.
- **Assumed:** that Step 10 calls execution-control `configure` or `arm`, and that it rejects unsigned error replies. Both need Mothership's code or logs to confirm.

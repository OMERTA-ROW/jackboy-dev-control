# Mothership → Jackboy handoff (`jackboy.omni-handoff/v1`)

Lets Evolution Mothership hand an owner-approved held task to Jackboy as a **queued** job.
Jackboy stays the gatekeeper: nothing is sent to OMNI by this endpoint. The owner still
reviews the job on the OMNI page and approves it with a passkey; the Kill Switch, project
authorization and spend caps apply as before.

## Settings (Jackboy side)

| Name | Meaning |
| --- | --- |
| `JACKBOY_HANDOFF_ENABLED` | Must be exactly `true`, otherwise every call gets `503 handoff_disabled`. |
| `JACKBOY_HANDOFF_CLIENT_ID` | Caller id, `[A-Za-z0-9_-]{1,64}`. |
| `JACKBOY_HANDOFF_HMAC_SECRET` | Shared secret, at least 32 characters. |

## Request

`POST https://<jackboy>/api/public/omni-handoff/v1` (HTTPS only, no query string, body ≤ 8 KB).

Headers: `x-jackboy-contract: jackboy.omni-handoff/v1`, `x-jackboy-client`, `x-jackboy-timestamp`
(unix seconds, within 60 s), `x-jackboy-nonce` (32 lowercase hex, single use),
`x-jackboy-signature` (64 lowercase hex):

```
HMAC_SHA256(secret, "jackboy.omni-handoff/v1\nPOST\n/api/public/omni-handoff/v1\n<client>\n<timestamp>\n<nonce>\n<raw body>")
```

Bodies (strict — unknown fields are rejected):

```json
{ "action": "create", "taskId": "<uuid>", "projectId": "<uuid>", "repo": "owner/name",
  "kind": "test" | "code", "instructions": "3–4000 chars", "digest": "<sha256 hex of instructions>" }
{ "action": "status", "taskId": "<uuid>" }
```

## Response

Authenticated responses carry `X-Jackboy-Proof`:

```
HMAC_SHA256(secret, "jackboy.omni-handoff/v1\nresponse\n<request nonce>\n<http status>\n<raw body>")
```

Success: `{ "contract", "requestNonce", "jackboyJobId", "status" }` — `201` for a new job,
`200` when the same `taskId` was already handed off (same job returned).

| Status | Error | When |
| --- | --- | --- |
| 503 | `handoff_disabled` / `handoff_unavailable` | Off, or storage unavailable |
| 400 | `https_post_required` / `invalid_body` / `invalid_request` | Wrong transport or body shape |
| 401 | `authentication_failed` | Bad client, signature, clock or reused nonce |
| 413 | `body_too_large` | Body over 8 KB |
| 423 | `kill_switch_on` | Kill Switch on or unreadable (create only) |
| 422 | `digest_mismatch` | `digest` is not sha256 of `instructions` |
| 403 | `project_not_authorized` / `owner_unavailable` | Project not enrolled, repo ≠ project's `repo_url`, or not exactly one owner |
| 409 | `task_conflict` | `taskId` reused with different content |
| 404 | `task_not_found` | Status for an unknown task |

`status` never returns instructions, results, logs or secrets. Every authenticated call is
written to the activity log (`omni.handoff.create`, `omni.handoff.status`, `omni.handoff.refused`).

## Database

The tables and the `omni_handoff_create` function are in `scripts/omni-handoff-v1-migration.sql`.
It is **not applied** by merging; it needs a separate owner-approved migration step. Until then
the endpoint answers `503` even if enabled.

# OMNI ↔ Jackboy secure link — owner review

## Implemented scope

`omni.link/v2` adds OMNI-initiated, authenticated request/response communication to the existing link. Jackboy authenticates OMNI, checks one explicitly authorized owner/project/approval, issues a five-minute session, reports capabilities, accepts a unique job UUID and returns durable progress/results. OMNI verifies Jackboy's response proof and maintains a local audit. Only the fixed `protocol.self-test` job is supported. It checks SHA-256 against a known answer, absence of inherited credentials, and denied process resource permissions. There is no user code, repository input, shell command, model call, GitHub request, write/merge/deployment action or general agent executor.

The existing `omni-link.ts` HMAC implementation, service-side Supabase client, `owner_projects`, owner roles, global automation pause, callback nonce store and append-only Site Log are reused. Two new service-only tables separate short-lived sessions and inbound jobs from existing outbound `omni_jobs`; this avoids changing CODE's routing or approval semantics. Audits use the `config` category and fixed text/IDs, never request bodies, tokens, signatures, provider errors or subprocess output.

Existing Jackboy → OMNI dispatch and signed result callbacks remain unchanged. The reverse session does **not** set `omni_connection.verified`. CODE's owner approvals, workflow allowlist, GitHub fallback and verified-OMNI gate remain unchanged. No GitHub App installation token, CODE credential or provider secret is sent across the new link. The fixture repair in PR #8 is retained as the base of this branch.

## Protocol and storage

Single route: `POST /api/public/omni/link`, HTTPS only, no query string or redirects.

Body: `{ "action": "handshake|submit|run|status|cancel", "projectId": "uuid", "jobId": "uuid", "kind": "protocol.self-test" }`. Omit `jobId` for handshake; `kind` is required only for submit. Other fields and actions are rejected. Bodies are limited to 8 KiB and two seconds of reading.

Headers: `Authorization: Bearer <bootstrap-or-session>`, `X-Omni-Client`, Unix-seconds `X-Omni-Timestamp`, random 16-byte hex `X-Omni-Nonce`, `X-Omni-Signature`.

The request HMAC-SHA256 covers newline-separated contract, method, exact path, timestamp, nonce, SHA-256 of the bearer and exact raw body. The response `X-Omni-Proof` covers contract, `response`, request nonce, HTTP status and exact response body. This binds replies to individual requests and prevents response substitution. TLS validates the server certificate; the shared scoped HMAC key proves possession on both sides. No custom cryptographic cipher is used.

Session tokens are random and stored only as SHA-256 hashes in PostgreSQL; OMNI holds them only in memory. Each request rechecks expiry, approval ID, project ownership/active status, owner role and global pause. Owner approval expires within 24 hours; sessions cannot outlast it. Changing the configured approval ID invalidates access to old sessions/jobs. Rotate both dedicated keys to revoke the cryptographic relationship. Disabling the listener blocks all new requests.

Freshness is ±60 seconds. Nonces are consumed atomically in PostgreSQL and retained for ten minutes, longer than the acceptance window. A client advisory transaction lock protects session quotas, job deduplication and the two-job in-flight limit across replicas. Job IDs are immutable; a duplicate returns its existing state, and a different approval/project cannot read or reuse it. Eight live sessions maximum per client. State changes and successful-handshake audit writes commit together; a storage/audit error never reports success. Denied authenticated requests also record a generic rejection. Network/TLS and disabled-route rejections do not have a database audit.

Jobs expire after 60 seconds or the earlier approval deadline. Expiry is materialized on the next protocol request, not by an autonomous scheduler. `run` atomically claims one queued job. Only the successful claimant starts the test. `status` reports queued/running/final states. `cancel` stops queued work or marks running work cancelled; a 100 ms monitor aborts the bounded subprocess. The process has a three-second timeout and 1 KiB output cap. Crash-interrupted jobs time out and never automatically rerun. Successful checks count is three; a failed execution reports zero confirmed checks, not invented output.

OMNI retries transient job transport failures at most three attempts with the same job ID and fresh nonce. Expired sessions reconnect. Lost responses reconcile through durable job identity, not new execution. Initial handshake failure is returned for explicit retry. Client audit failures stop outgoing work; response-time audit failures leave the outcome uncertain and require status reconciliation.

## Runtime boundary

Jackboy's current web build targets Cloudflare Workers. That environment cannot run this subprocess. The web route stays disabled by default and reports `ready: false` without an explicitly supported Node runner; it refuses job submission/execution. Do not configure the Node runner flag on the Cloudflare deployment.

**Chosen hosting (owner decision, Nov 6 2026): Railway.** The Jackboy app is built for Node (`NITRO_PRESET=node-server`, see `railway.json`) and serves the link from the **existing web route** `/api/public/omni/link` behind Railway's public HTTPS edge. `package.json` pins `engines.node >=26`, so the runner check can pass on that host. There is no separate link server, bind address, or TLS certificate/key files: Railway terminates TLS.

Railway forwards plain HTTP to the container. The route treats such a request as HTTPS only when `OMNI_LINK_BEHIND_HTTPS_PROXY=true`, `JACKBOY_LINK_ORIGIN` is a clean `https://` origin, the proxy-appended (last) `X-Forwarded-Proto` value is exactly `https`, and the forwarded/Host host equals that origin's host (`linkRequestUrl` in `src/lib/omni-session.ts`). Without the flag, plain HTTP is still refused with `https_post_required`, and the Lovable/Cloudflare deployment behaves as before. All signature, nonce, freshness, path and body-size checks are unchanged.

`scripts/omni-link-server.mjs` is kept **only** for the local cross-repository TLS test. It is not used for deployment.

The child uses a temporary directory, empty inherited environment, fixed trusted JavaScript, Node permission restrictions, no shell and no caller-controlled arguments. Node's [permission model](https://nodejs.org/api/permissions.html) is **not a sandbox for malicious code**. This implementation must not be extended to execute submitted scripts or repository tests without a separately reviewed OS/container isolation system. The old OMNI inbox worker's temporary checkout is also not such a sandbox and is not activated here.

## Required owner permissions — not performed by this PR

1. Review this PR and its dependency, CODE fixture PR #8. Review the companion OMNI PR based on the existing inbox PR #1. Merge/deploy decisions remain separate owner actions.
2. Session storage: **applied** on 2026-11-05 22:36 UTC (recorded in the migration journal as `0044_omni_sessions.sql`, identical SQL to `0030_omni_sessions.sql`). It grants the RPC/tables only to `service_role`; browser roles cannot call/read them.
3. Approve one active `owner_projects.id`, its actual owner UUID, a new approval UUID and an expiry no more than 24 hours away. No project inventory, chat instruction or existing connection creates this grant automatically. Owner-role and project ownership are checked on the server.
4. Provision two **new, independent**, random 32-byte hex secrets in the hosts' managed backend secret stores: `OMNI_LINK_BOOTSTRAP_KEY` and `OMNI_LINK_HMAC_SECRET`. Do not reuse GitHub App, CODE, OMNI legacy or model credentials. Do not put values in chat, command arguments, source, `.env` committed to Git, or logs. At-rest encryption and access policy are provided by the chosen secret manager. Session tokens are never stored in a file.
5. Provision the Railway production service from this repository (`railway.json`). Railway provides the public HTTPS edge; no certificate files are needed. **Blocker:** the link storage needs `SUPABASE_SERVICE_ROLE_KEY`, which Lovable Cloud does not expose, so the Railway copy fails closed (`link_unavailable`) until a separately reviewed storage path is approved.
6. Explicitly authorize enabling **only the protocol self-test** using the variables below. General CODE jobs continue through existing owner cards and provider-native workflows; this grant cannot unlock them.

Railway production service variables (names only; values supplied through Railway's variable store, never printed):

| Variable | Purpose |
|---|---|
| `OMNI_LINK_ENABLED` | **Leave unset/off** until the self-test is separately approved; otherwise 503 |
| `OMNI_LINK_NODE_RUNNER_ENABLED` | **Leave unset/off** until the self-test is separately approved |
| `OMNI_LINK_CLIENT_ID` | 1–64 alphanumeric/underscore/hyphen identity |
| `OMNI_LINK_PROJECT_ID` | Authorized existing owner project UUID |
| `OMNI_LINK_OWNER_ID` | Actual owner UUID |
| `OMNI_LINK_APPROVAL_ID` | Owner-reviewed grant UUID |
| `OMNI_LINK_APPROVAL_EXPIRES_AT` | ISO timestamp, at most 24 hours ahead |
| `OMNI_LINK_BOOTSTRAP_KEY`, `OMNI_LINK_HMAC_SECRET` | Independent scoped secrets |
| `JACKBOY_LINK_ORIGIN` | Railway public `https://` origin, no path/query/credentials |
| `OMNI_LINK_BEHIND_HTTPS_PROXY` | `true` — trust Railway's forwarded HTTPS (rules above) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Backend database access (service role key not available from Lovable Cloud) |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID` | Public build-time values for the app bundle |
| `NITRO_PRESET` | `node-server`; already set in `railway.json`'s build command |
| `PORT` | Set automatically by Railway |

No longer used: `OMNI_LINK_TLS_CERT_FILE`, `OMNI_LINK_TLS_KEY_FILE`, `OMNI_LINK_BIND_ADDRESS`. Deliberately not on Railway (least privilege): GitHub App/token, CODE/provider keys, `OPENAI_API_KEY`, `LOVABLE_API_KEY`, `OWNER_EMAIL`, mail and other app secrets; other pages on the Railway copy fail closed without them.

After separate self-test approval only: set the two opt-in flags on the Railway service and redeploy. Unset `OMNI_LINK_ENABLED` (or stop the Railway service) to disable the link. Preserve database audit/job rows; do not drop tables as a routine rollback. Remove opt-in settings and revoke the dedicated secrets to withdraw permission. No existing GitHub credential rotation is needed.

## Verification

`bun install --frozen-lockfile`, then:

```sh
node --test tests/omni-session.test.mjs
node --test tests/code-security.test.mjs tests/code-runtime.test.mjs tests/code-contract.test.mjs tests/code-patch.test.mjs
npm test
npx tsc --noEmit
npm run build
```

For the cross-repository TLS test, set `OMNI_INBOX_DIR` to the companion checkout's absolute `inbox/` directory when running the first command. Without it only that test is explicitly skipped. OpenSSL creates a short-lived local test certificate; Go trusts only that certificate for the test. TLS verification is never disabled. The test uses the real Node HTTPS adapter, real TypeScript handler, actual SQL migration in local PGlite PostgreSQL, and real restricted subprocess. It makes no production/provider calls.

PGlite verifies SQL behavior and concurrent application requests but is a single embedded PostgreSQL instance; production multi-replica load, Cloud RLS deployment and real-host operations still need owner-approved staging validation. Supabase transport is replaced by the direct SQL adapter in integration tests. Tests do not prove live production connectivity.

### Local review results

- Secure-link integration: **16/16 passed**, including the Go client over verified local TLS and lost acknowledgements after job submission/completion (one execution only).
- Existing CODE Node security/runtime/contract/patch tests: **16/16 passed**; fixture repair unchanged.
- Existing application suite: **317/317 passed**.
- TypeScript and production web build: passed; the build is not a deployment or proof of Cloudflare subprocess support.
- All new TypeScript/JavaScript files pass ESLint including formatting. Repository-wide non-format lint still reports **48 errors and 35 warnings**, identical to the repaired base branch. Existing lint debt was not broadly changed. Full repository formatting lint is not claimed green.
- Companion Go inbox/client race tests, vet/build and original CLI tests/vet passed.
- No production migration, key provisioning, provider call, CODE workflow dispatch or live agent activation occurred.

# OMNI ↔ Jackboy secure link — owner review

## Implemented scope

`omni.link/v2` adds OMNI-initiated, authenticated request/response communication to the existing link. Jackboy authenticates OMNI, checks one explicitly authorized owner/project/approval, issues a five-minute session, reports capabilities, accepts a unique job UUID and returns durable progress/results. OMNI verifies Jackboy's response proof and maintains a local audit. Only the fixed `protocol.self-test` job is supported. It checks SHA-256 against a known answer, absence of inherited credentials, and denied process resource permissions. There is no user code, repository input, shell command, model call, GitHub request, write/merge/deployment action or general agent executor.

The existing `omni-link.ts` HMAC implementation, service-side Supabase client, `owner_projects`, owner roles, global automation pause, callback nonce store and append-only Site Log are reused. Two new service-only tables separate short-lived sessions and inbound jobs from existing outbound `omni_jobs`; this avoids changing CODE's routing or approval semantics. Audits use the `config` category and fixed text/IDs, never request bodies, tokens, signatures, provider errors or subprocess output.

Jackboy → OMNI legacy dispatch and its unscoped result callback are disabled: a successful transport handshake does not authorize queued jobs, and old callbacks now return HTTP 410. Previously sent jobs cannot receive legacy updates until a separately reviewed reconciliation path exists. The reverse session does **not** set `omni_connection.verified`. CODE's owner approvals, workflow allowlist, GitHub fallback and verified-OMNI gate remain unchanged. No GitHub App installation token, CODE credential or provider secret is sent across the reverse link.

The OMNI panel's **Verify latest link** action uses the owner-only `probeOmniConnection` read path. It checks configured setting names/validity, session-table availability, the latest recorded OMNI session expiry, and runner configuration; it does not call OMNI, run the protocol self-test, send jobs, enable the link, or deploy. An unexpired session is not proof of current bridge reachability. A runner URL must be a bare HTTPS origin because Jackboy appends `/api/public/omni/runner`; diagnostics explain malformed or duplicated paths without returning configured URLs or secrets. The Handoffs panel keeps the legacy outbound link status separate, and its project grants do not enable the disabled legacy dispatcher. Blocker guidance may open project access, project review, or Settings, but never changes authorization or the Kill Switch. Owner diagnostics reconcile expired project access and job grants, revoke dependent grants, and append audit records; replacement project access still requires a fresh passkey. Remote error bodies and job error details are withheld from the UI and Site Log; diagnostics expose only safe status codes or missing secret names, never values.

The internal build queue is a planning record. A queue card shows `queued — not sent` until a recorded send timestamp exists; only then can remote status and a validated GitHub pull-request link be shown. Guardian `pending` is not a pass and does not permit dispatch. The Jackboy repository does not have verified write access to the Orbiting Minds Mothership project, so a Mothership-side build UI cannot be repaired or deployed from this repository alone.

The replacement outbound protocol is disabled by default. An explicit owner-only server function invokes a Node-only client that revalidates the grant, audits the request, signs it, verifies TLS and response proofs, and records the verified quarantine/cancellation receipt. The owner review panel previews the exact queued job and requires a fresh passkey; there is no scheduler or automatic sender. The Mothership has a disabled receive-only route and transactional quarantine storage. `omni_jobs.project_id` references `agent_projects`, while the reverse link uses `owner_projects`; the two IDs must not be assumed interchangeable. The isolated cross-repository TLS test simulates passkey and MFA identity and checks the same canonical payload digest on both sides; it does not prove the real authentication ceremonies or distributed revocation.

The local, unapplied `0045_omni_dispatch_grants.sql` migration prepares a service-role-only, 15-minute receive-only grant for a single queued test job. Issuance consumes a registered owner passkey confirmation bound to that job and atomically appends an audit record. Revalidation checks the original project, repository, job contents and global pause; revocation is durable. Owner-only server functions expose issuance, revocation and explicit dispatch. A point-in-time check alone cannot prevent revocation racing with remote receipt: Jackboy and Mothership grants must be revoked separately, and the Mothership quarantine must remain non-executing. Review migration numbering and actual database history before any application.

A disabled-by-default `jackboy.dispatch-callback/v2` receiver accepts only signed
`quarantined` or `cancelled` state for an exact, currently valid grant and
payload digest. Its nonce, receipt and audit commit together; cancelled receipts
cannot reopen. The legacy callback remains HTTP 410. An explicit Mothership
owner action can send its stored quarantine state over certificate-verified TLS;
the isolated test exercises this path with simulated identities and two local
databases. A signed receipt does not authorize execution, and a missing
acknowledgement needs reconciliation rather than an automatic retry. The
callback's separately scoped client ID and HMAC secret must remain unset until
reviewed staging configuration is approved.

For a future approved staging setup only, Jackboy's sender requires
`OMNI_DISPATCH_ENABLED`, `OMNI_DISPATCH_ORIGIN`,
`OMNI_DISPATCH_CLIENT_ID`, and `OMNI_DISPATCH_HMAC_SECRET`.
`OMNI_DISPATCH_CA_FILE` is optional: unset or empty uses Node's normal trusted
certificates (including standard Railway HTTPS); a configured file supplies
the custom CA. File or TLS errors fail the request without falling back to
system trust, and certificate verification remains enabled. Its callback receiver
requires `OMNI_DISPATCH_CALLBACK_ENABLED`, `OMNI_DISPATCH_CALLBACK_CLIENT_ID`,
and `OMNI_DISPATCH_CALLBACK_SECRET`. Use separate managed secrets for each
direction and exact HTTPS names covered by the server certificates. These
settings are not configured by this change.

## Protocol and storage

### Read-only Railway configuration attestation

`action: "configuration"` on the same signed HTTPS link is a metadata-only
bootstrap request containing only `action` and `projectId`. It checks the
existing client identity/keys and uses migration `0064_omni_configuration_probe`
to verify the active owned project, owner role, global pause, single-use nonce
and an atomic Site Log insert. Probes are capped at 60 per client/10 minutes.
No sessions, jobs, execution grants, provider calls or switches are created.
Because this is configuration evidence before activation, execution approval
expiry and `OMNI_LINK_ENABLED` are not prerequisites; the existing execution
route's approval, passkey and switch gates are unchanged.

Jackboy on Lovable relays the probe using its existing
`OMNI_LINK_REMOTE_RUNNER_ENABLED`, `OMNI_LINK_REMOTE_RUNNER_URL` and managed
`OMNI_LINK_REMOTE_RUNNER_SECRET`. The runner receives signed
`kind: "runner.configuration"` with a correlation UUID (not a stored job),
returns nonce-bound boolean mode/flag/secret-presence/runtime metadata, and
**never calls `runProtocolSelfTest`** for this kind. Both response proofs must
verify before configuration is reported. Missing configuration, transport,
signature, owner, pause or audit evidence fails closed.

The Railway service `Evolution / production / jackboy-dev-control` already
contains `OMNI_LINK_RUNNER_MODE=true`, `OMNI_LINK_NODE_RUNNER_ENABLED=true`,
and the runner secret (read-only audit, 2026-11-12). Do not repeat this setup.
The runner owns no database or scoped link credentials. Mothership needs only
the nonsecret expected `JACKBOY_LINK_RUNNER_ORIGIN` in addition to its existing
Jackboy link identity; it must **not** receive the runner secret. The live
Lovable caller is outside Railway's private mesh, so use the runner's public
HTTPS origin, not private HTTP. Publication of this code and application of
the metadata-authorization migration remain separate owner decisions.

This probe is not live self-test proof and never sets `omni_connection.verified`.
The ordinary job/session protocol below continues to require execution grants.

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

| Variable                                                                         | Purpose                                                                       |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `OMNI_LINK_ENABLED`                                                              | **Leave unset/off** until the self-test is separately approved; otherwise 503 |
| `OMNI_LINK_NODE_RUNNER_ENABLED`                                                  | **Leave unset/off** until the self-test is separately approved                |
| `OMNI_LINK_CLIENT_ID`                                                            | 1–64 alphanumeric/underscore/hyphen identity                                  |
| `OMNI_LINK_PROJECT_ID`                                                           | Authorized existing owner project UUID                                        |
| `OMNI_LINK_OWNER_ID`                                                             | Actual owner UUID                                                             |
| `OMNI_LINK_APPROVAL_ID`                                                          | Owner-reviewed grant UUID                                                     |
| `OMNI_LINK_APPROVAL_EXPIRES_AT`                                                  | ISO timestamp, at most 24 hours ahead                                         |
| `OMNI_LINK_BOOTSTRAP_KEY`, `OMNI_LINK_HMAC_SECRET`                               | Independent scoped secrets                                                    |
| `JACKBOY_LINK_ORIGIN`                                                            | Railway public `https://` origin, no path/query/credentials                   |
| `OMNI_LINK_BEHIND_HTTPS_PROXY`                                                   | `true` — trust Railway's forwarded HTTPS (rules above)                        |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`                                      | Backend database access (service role key not available from Lovable Cloud)   |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID` | Public build-time values for the app bundle                                   |
| `NITRO_PRESET`                                                                   | `node-server`; already set in `railway.json`'s build command                  |
| `PORT`                                                                           | Set automatically by Railway                                                  |

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

For the cross-repository tests, set `OMNI_INBOX_DIR` to the Go companion checkout's absolute `inbox/` directory and `MOTHERSHIP_TEST_ROOT` to the Mothership checkout containing the signed configuration client when running the first command. An omitted reference explicitly skips its corresponding test. CODE acceptance checks out both public companions at pinned commits and supplies both references inside the existing network-isolated suite; its zero-skipped-tests gate remains enforced. OpenSSL creates a short-lived local test certificate; Go trusts only that certificate for the test. TLS verification is never disabled. The tests use the real Node HTTPS adapter, real TypeScript handlers, actual SQL migrations in local PGlite PostgreSQL, and a real restricted subprocess. The configuration chain verifies both signed metadata hops with zero executor calls. No production/provider calls are made.

PGlite verifies SQL behavior and concurrent application requests but is a single embedded PostgreSQL instance; production multi-replica load, Cloud RLS deployment and real-host operations still need owner-approved staging validation. Supabase transport is replaced by the direct SQL adapter in integration tests. Tests do not prove live production connectivity.

### Local review results

- Secure-link integration: **19/19 passed**, including the Go client over verified local TLS, lost acknowledgements after job submission/completion (one execution only), and signed configuration metadata without execution.
- Existing CODE Node security/runtime/contract/patch tests: **16/16 passed**; fixture repair unchanged.
- Existing application suite: **317/317 passed**.
- TypeScript and production web build: passed; the build is not a deployment or proof of Cloudflare subprocess support.
- All new TypeScript/JavaScript files pass ESLint including formatting. Repository-wide non-format lint still reports **48 errors and 35 warnings**, identical to the repaired base branch. Existing lint debt was not broadly changed. Full repository formatting lint is not claimed green.
- Companion Go inbox/client race tests, vet/build and original CLI tests/vet passed.
- No production migration, key provisioning, provider call, CODE workflow dispatch or live agent activation occurred.

## Remote self-test runner (approved 2026-11-07)

The live site cannot start a Node child process, and the Railway copy cannot reach Jackboy's database. Instead, OMNI talks only to the live site (`JACKBOY_LINK_ORIGIN=https://jackboy-dev-control.lovable.app`). The live site runs every session/owner/project/approval/Kill Switch/job-state check and keeps all storage. On `run`, if it has no local runner, it sends one signed request to a **stateless runner-only** Railway host at `POST /api/public/omni/runner` (contract `omni.runner/v1`).

- Request: exact body `{"kind":"protocol.self-test","jobId":<uuid>}`, `X-Runner-Timestamp` (ms, ±60 s), `X-Runner-Nonce` (one-time, kept in memory for 10 minutes), `X-Runner-Signature` = HMAC-SHA256 over `omni.runner/v1\nrequest\n<ts>\n<nonce>\n<body>`. Bodies are capped at 1 KiB.
- Response: `{jobId, nonce, passed}` with `X-Runner-Proof` over `omni.runner/v1\nresponse\n<nonce>\n<body>`. The live site checks the proof, job ID and nonce. If the runner is unreachable (5 s timeout) or the proof is invalid, the job **fails** (`runnerError: runner_unreachable | runner_proof_invalid`). It is never retried silently and never counted as a pass.
- In runner mode (`OMNI_LINK_RUNNER_MODE=true`), the host answers every other path with 404. It holds no database credentials and no OMNI link secrets.

Runner API routing checks (no job execution):

- The runner path is handled directly for every HTTP method, never by the dashboard HTML fallback. On a configured dedicated host, GET/PUT/DELETE return JSON HTTP 405 with `Allow: POST`; unsigned or invalidly signed POST requests are refused. Disabled or misconfigured runner hosts return JSON 404.
- Railway loopback requests retain runner-only mode when the platform supplies `RAILWAY_ENVIRONMENT_ID`. Local development without that marker and Lovable hosts retain the dashboard safety guard; site-only settings still exclude runner-only mode.
- Verify the deployed source SHA in Railway's deployment metadata. A listening port or dashboard HTML does not identify a build or prove authenticated runner readiness.
- A reverse-link `session_expired_or_invalid` response is distinct from runner authentication. The live site's session must match token hash, client, project and current approval ID and remain unexpired (at most five minutes, bounded by approval expiry). Missing/mismatched approval or unavailable saved-approval storage blocks the link; project handoffs separately require unrevoked/unexpired project authorization, a verified live link and a job-scoped grant. Never infer which failed from a generic client message or bypass these checks.

Settings. Live site (Jackboy secrets): `OMNI_LINK_REMOTE_RUNNER_ENABLED=true`, `OMNI_LINK_REMOTE_RUNNER_URL` (https origin only), `OMNI_LINK_REMOTE_RUNNER_SECRET` (32+ chars, shared). Railway runner host: `OMNI_LINK_RUNNER_MODE=true`, `OMNI_LINK_NODE_RUNNER_ENABLED=true`, the same `OMNI_LINK_REMOTE_RUNNER_SECRET`; remove the link secrets and database keys from that host. To disable, unset `OMNI_LINK_REMOTE_RUNNER_ENABLED` on Jackboy.

## Unified activation authority (feature branch; unapplied and not deployed)

This branch merges upstream main `f49f86dd3631e88f396346ca171aea22ae3b0e5f`,
including published 0063–0067, without changing their bytes or timestamps.
Only the unapplied feature migrations were renumbered after that history.
Migration `0068_omni_execution_authority.sql` adds service-only connection/job state
and `omni_execution_control`, not general execution to the existing protocol
self-test. Signed `action: "execution-control"` requests use the existing
`omni.link/v2` request/reply proof and durable nonces (400 requests/client/minute,
expired execution nonces cleaned without deleting legacy callback nonces).
Mothership authenticates the owner and approval; Jackboy independently enforces
the configured owner/project and saved approval expiration. Executor credentials
are separate and can only claim, check permission and finish a hash-bound plan.
Mothership's integrated upstream baseline `4c3094866722036ffe542568f1c25519a8e767da`
supplies its sole activation and permit mirror (0053–0056), with additive
unresolved-attempt guard 0057 and Stop propagation 0058. Published migration0056
was preserved byte-for-byte; only the previously unapplied feature migration was renumbered. No duplicate
Mothership activation saga is retained. Review the separate intelligence branch's
historical 0053 ordering before combining it with this upstream chain.

### Session safety and execution permits

`safety`, `permit.request` and `permit.release` use an actual current
`omni_link_sessions` token; bootstrap keys cannot replace session authorization.
The database validates token hash, client, project, approval and expiry.
`omni.safety/v1` returns a fresh 30-second snapshot with independent Kill Switch,
CODE Emergency Stop, CODE enabled, authorization, autonomous admission, manual
diagnostics and the actual unexpired permit count.

The installed native `0066_omni_execution_permits` / published 0067 authority
remains the **only permit issuer**. The bounded adapter reuses its fresh,
approval-bound Jackboy `omni_autonomy` passkey authorization, session/nonce checks,
scope, one-active-permit limit and $1/job reservation against $5/client/UTC day.
Mothership approval never substitutes for that separate owner authorization.
Native autonomous and CODE permits remain supported; only the separate bounded
worker is restricted to already authorized exact autonomous jobs.
The native `omni.permit/v1`
It carries id, jobId, kind, digest, status, issuedAt, expiresAt, renewals,
limits ($0.50/call, $1/task, $5/day), clientId, projectId, approvalId,
renewEverySeconds (20), and signature. The canonical HMAC joins
`contract,id,jobId,kind,digest,clientId,projectId,approvalId,expiresAt` with newlines;
the whole reply proof also covers limits and every response field.
Expiry is bounded by the job, authorization and 60 seconds. A lapsed permit never
renews and terminal job scope/state never reopens. `permit.release` closes the
permission record, **not** proof of process termination; bounded cancellation has
its separate signed acknowledgement. Existing CODE lanes are not rerouted.
Both a permit and durable single-use
claim are required before the bounded worker executes. Its signed completion
reports Jackboy's actual terminal state, including a simultaneous Stop cancellation.

Additive `0069_omni_mothership_lease.sql` mirrors those native permits and requires a **one-second Mothership
liveness lease** for every claim/permission. Mothership checks its own current
Stop and durable permit every 250 ms before renewing this exact-job/hash lease.
Only Mothership credentials can renew it; the worker cannot. A missing/expired
lease requests cancellation and cannot revive, even if the 20-second-renewal
permit is still valid. A fresh worker claim/permission heartbeat (within 1.5 seconds),
lease and unexpired permit are required to report Running; stale evidence is Blocked.
An authorization or permit record alone never proves a running process.
Process/network loss therefore fails closed rather than
leaving local Stop hidden until permit renewal. Lease, permit/release and CODE
Stop share the same database lock. No owner decision is synthesized.

Step 9 persists an authorized connection and verifies the signed safety reply.
Step 10 checks CODE gateway/workflow identity/spending and live executor
configuration, and requires a fresh recorded executor verification. It configures
only: CODE remains off, OMNI remains disarmed and Emergency Stop stays unchanged.
Arming is an independent owner action after the reviewed release and all existing
CODE enable/passkey gates. Approval never queues or starts a plan.

Forward-only `0070_omni_safety_generation.sql` also rechecks the actual meter and
spending guard at every native issue/renewal and safety read. Each Stop,
global-pause or CODE-off transition advances a durable generation outside
best-effort revocation; an old active permit cannot renew even after Stop release
when revocation failed. Existing pre-install cached permits are invalidated.
CODE claim/admit/dispatch lock global policy before runtime controls, so Stop
cannot commit in the previously unprotected dispatch interleaving. Active
provider-call watchers fail closed on global pause, including unreadable policy.

Admission and Stop share lock order: policy, CODE controls, then client/job locks.
Stop/pause/disable disarm connections and mark active plans
`cancel_requested` transactionally. Network cancellation happens after commit and
only a signed termination acknowledgement can finish a **claimed** job's cancellation
with its audit. Unclaimed cancelled jobs can use durable database non-claim proof:
the cancelled state makes subsequent claim impossible. Failures remain pending
and visible, not success-shaped. Disarm,
unconfigure and revoke also drain this outbox. Independent global Kill Switch
enforcement and existing CODE lanes are unchanged.

The Settings activation panel and Mothership read this authoritative state, showing
configuration separately from Blocked/Configured/Running. Unreadable safety is
Blocked. Mothership's separate manual diagnostics retain their own policy; Jackboy
Stop does not release or rewrite any manual sandbox gate.

The new service lives at Mothership `services/omni-autonomous/`, contract
`omni.autonomous/v1`, release `omni-bounded-plan-1`, default disabled. It supports
only bounded preauthorized argv plans, not model-driven agents, repositories,
network, provider calls, deployment or shell expansion. Paid-provider cost is zero
because provider calls are unsupported; infrastructure cost is not measured.
Permission polling every 250 ms aborts on unverifiable state (1.5-second request
deadline and 2-second signed-response freshness). Cancellation is bounded and must
be acknowledged before claiming termination.
An instance that does not own the active job refuses cancellation acknowledgement;
a restarted or load-balanced instance cannot falsely prove another process exited.

**Owner prerequisites:** review both feature branches and journals; separately
authorize staging deployment/migrations; provision the dedicated Linux service
with separate control/permission credentials; prove actual isolation, resource
limits, descendant cancellation, cross-system Stop and replay/restart behavior
before setting a reviewed release. Then perform fresh owner Steps 8/9, explicitly
set the reviewed release on all services, verify the executor, and approve/activate
Step 10, with a separate fresh Jackboy autonomy authorization after the live
Step 8/9 prerequisites. Enable saved CODE and release CODE Emergency Stop only through their
**distinct** freshly approved passkey controls; global Kill Switch is independent.
Enable the executor separately,
explicitly arm, then authorize one plan. Full setting names and ordered owner
actions are in Mothership `docs/OMNI-BACKEND-CONTRACT.md`, unified activation section.
Never rotate production credentials or weaken sandbox privileges to pass a test.

No hosted migration, deployment, approval, Stop release or production execution
was performed by this work. Upstream records an owner-installed 0066; we have not
reverified the hosted journal. Our additive **0068–0070 remain unapplied**.
Local disposable tests do not verify a live connection. Actual Linux
verification runs separately in Mothership's credential-free GitHub-hosted VM;
the exact Railway worker image/kernel and signed live cancellation still require
separately authorized staging verification. Actual Ubuntu 22.04 isolation,
filesystem/resource/network restrictions, timeout and descendant cancellation
passed **5/5, zero skipped**:
[Linux evidence](https://github.com/OMERTA-ROW/orbiting-minds-mothership/actions/runs/43558863121).
Ubuntu 24.04 refused namespace setup; no host policy was weakened.
New autonomous execution remains disabled.

Local feature evidence: Node 26.13.1 focused Vitest **141 passed (10 files)**;
isolated release-surface checks **115 passed, zero failed/skipped** (real
PostgreSQL/PGLite plus workflow/history checks), including
genuine simultaneous permit/lease/Stop and issuance/release transactions and
elapsed-time lease expiry. Typecheck,
changed-file lint/format, `git diff --check` and the Railway Node-server build pass.
These are not authenticated live-system or Linux isolation results.

```sh
node node_modules/vitest/vitest.mjs run src/lib/{omni-execution.server,omni-configuration.server,omni-permit,omni-permit-e2e,code-safety,code-gateway.server,code-gateway,safety-controls,safety-controls.server}.test.ts src/test/activation-panel.test.tsx
node node_modules/typescript/bin/tsc --noEmit --strict
NITRO_PRESET=node-server node node_modules/vite/bin/vite.js build
git diff --check
```

With an isolated loopback PostgreSQL cluster using superuser `postgres`, and `pg`
available through the repository or a separate fixture package:
Set `STAGING_PG_URL=postgresql://postgres@127.0.0.1:55483/postgres` and, if needed,
`STAGING_PG_MODULE_FROM=/path/to/local/pg-tests/package.json`, then run:

```sh
node --test --test-concurrency=1 \
  tests/code-migration-chain.test.mjs tests/code-sync-safety-pg.test.mjs \
  tests/code-spend-staging-pg.test.mjs tests/code-spend-hold-release.test.mjs \
  tests/code-provider-gateway-pg.test.mjs tests/omni-execution-pg.test.mjs \
  tests/omni-permit-stop-race.test.mjs tests/omni-execution-permit-draft.test.mjs \
  tests/migration-history-reconcile.test.mjs tests/code-workflow.test.mjs \
  tests/code-gateway-isolation.test.mjs
```

Never supply hosted credentials: fixtures create/drop their own databases.
The public version endpoint currently returns no source SHA; deployment identity,
actual connection and signed live Stop cancellation remain unverified.

An independent security review of starting commits `fda80c5` / `3f19d2e` found
two medium issues: delayed propagation of Mothership Stop and false cancellation
acknowledgement by an unowned executor instance. The durable Stop outbox,
one-second lease and unknown-instance refusal address those findings; regression
results are not an independent certification of the revised release or a live Stop drill.
The independent follow-up review of newly arrived upstream found four more
medium issues: missing current meter/guard checks, permit revival after failed
revocation and Stop release, active provider calls missing global Stop, and
unserialized CODE dispatch/global Stop. The owner selected fixing all issues.
0070, the active-call watcher and genuine concurrent/failed-revocation regression
tests address all four without editing published migrations. The six-finding
table and remaining staging/owner prerequisites are in Mothership
`docs/OMNI-BACKEND-CONTRACT.md`; the repaired release has not received a fresh
independent certification.

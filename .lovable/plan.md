# Plan: complete the OMNI protocol self-test end to end

## The problem today
- **Live site** (jackboy-dev-control.lovable.app): can check OMNI's identity, keep sessions, store jobs and write the Site Log. It can't start the small Node test program, so `submit` and `run` are refused with `runner_unavailable`.
- **Railway copy of Jackboy**: can run the test program, but can't reach Jackboy's stored data, so it answers `link_unavailable`.
- OMNI talks to only one Jackboy address (`JACKBOY_LINK_ORIGIN`). No single copy can do the whole job.

## Options compared

| | A. Live site keeps control, Railway only runs the test (recommended) | B. Database access for the Railway copy | C. Run the check inside the live site |
|---|---|---|---|
| How it works | OMNI talks only to the live site. On `run`, the live site sends one signed "run the fixed test" request to a runner-only Railway service and gets a signed pass/fail back. The live site records the result. | Give Railway a database credential so it can run the whole link itself. | Rewrite the check so the live site's own environment can run it. |
| Possible? | Yes, with what we have. | **No.** Lovable Cloud doesn't give out the full-access database key or a database password. A narrower credential would also need one, and the full key would give far more than this test needs. | Partly. The hash check works, but two of the three checks test Node's lock-down, which doesn't exist there. That would weaken what the test proves. |
| What Railway can reach | Nothing private: no database, no OMNI link secrets. It can only run the fixed test. | The whole database. | n/a |
| Blast radius if Railway leaks | Someone could ask it to run the harmless fixed test. They can't fake a result without the runner secret. | Every table. | n/a |

**Recommendation: A.** It's the smallest change. Railway gets no data access, the live site stays the only place that checks OMNI and records history, and the test keeps all three checks.

## What A changes (build phase, after your approval)
1. **Runner-only mode on the Railway copy.** A new route `POST /api/public/omni/runner` that works only when runner mode is on. It accepts one exact body (`{"kind":"protocol.self-test","jobId":<uuid>}`), signed with a new runner secret. It also checks the time (±60 s), a one-time code it remembers in memory for 10 minutes, and a size limit. It runs the existing fixed test and returns a signed `{jobId, passed}`. It has no database, no caller code and no arguments. When runner mode is on, every other Jackboy page on that copy refuses requests.
2. **Live site uses it.** When the live site's own test program isn't available and the remote runner is set up, `submit`/`run` no longer refuse with `runner_unavailable`. On `run`, all existing checks run first: session, owner, project, approval expiry, Kill Switch, job state. Then the live site calls the runner with a 5 s timeout, checks the signed reply against the same job ID, and saves pass or fail. If the runner can't be reached or the reply is bad, the job is marked failed (`runner_unreachable` / `runner_proof_invalid`). It is never retried silently and never counted as a pass.
3. **Readiness and Site Log.** The OMNI link readiness check shows "runner configured / reached / last result". Site Log lines record only fixed text and job IDs.
4. **Tests.** Bad signature, stale time, reused one-time code, wrong job ID, runner off, Kill Switch on, expired approval, unreachable runner leading to failure, and a successful round trip.
5. **Docs.** Update `docs/OMNI-SECURE-LINK.md` and AGENTS.md (one rule: the remote runner is stateless and runs only the fixed test).

Unchanged: CODE gates, spend limits, passkeys, the legacy dispatch staying off, and `omni_connection.verified`. No migration is needed because the existing job tables are reused.

## What you'd set (after the build is reviewed and published)
**Jackboy (Project Settings → Secrets), new:**
- `OMNI_LINK_REMOTE_RUNNER_URL`: the Railway copy's `https://…up.railway.app` address
- `OMNI_LINK_REMOTE_RUNNER_SECRET`: a new random secret. I'd generate it securely, and you copy the same value to Railway.
- `OMNI_LINK_REMOTE_RUNNER_ENABLED` = `true`

**Railway, the Jackboy copy (jackboy-dev-control-production):**
- `OMNI_LINK_RUNNER_MODE` = `true`
- `OMNI_LINK_NODE_RUNNER_ENABLED` = `true`
- `OMNI_LINK_REMOTE_RUNNER_SECRET`: the same value as in Jackboy
- **Remove** the OMNI_LINK_* link secrets and Supabase keys from this service. It no longer needs them.

**Railway, the OMNI service:** `JACKBOY_LINK_ORIGIN` = `https://jackboy-dev-control.lovable.app`. Everything else stays as you set it.

Then, in OMNI: `omni-link submit <new-uuid>` followed by `omni-link run <same-uuid>`.

## Handshake-only test you can run today
This is a one-off command on **OMNI's Railway service**. OMNI's `JACKBOY_LINK_ORIGIN` must be `https://jackboy-dev-control.lovable.app` (the live site, not the Railway copy):

```text
sh -c 'mkdir -m 700 -p /home/omni/link-audit && OMNI_LINK_AUDIT_DIR=/home/omni/link-audit omni-link handshake'
```

- The command needs `OMNI_LINK_AUDIT_DIR`, a private (0700) absolute folder. Without it, it stops with "OMNI_LINK_AUDIT_DIR must be…". The command above creates the folder. A one-off container's audit file is lost afterwards; set the variable on a persistent volume if you want to keep it.
- **Pass:** it prints one line of session state (session expiry and capabilities, no secrets). Jackboy's Site Log shows `omni.link.handshake`. Settings → CODE → OMNI link readiness says "unexpired session recorded; live bridge not tested".
- **Fail:** it exits with an error such as `link_disabled`, `authentication_failed` or `approval expired`. Signed-but-refused requests also show `omni.link.denied` in the Site Log.
- Don't run `submit`/`run` yet. They will return `runner_unavailable` until A is built.

## Needs your approval
1. Build option A as described.
2. When you're ready, set the values above. No secrets go in chat.

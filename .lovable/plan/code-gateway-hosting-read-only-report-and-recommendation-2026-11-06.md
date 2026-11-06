# CODE gateway hosting: read-only report and recommendation

Nothing was edited, migrated, deployed or changed. No secret values were read.

## 1. Settings the gateway path needs on any host

| Name | Public/secret | Source | Used for |
|---|---|---|---|
| CODE_PROVIDER_API_KEY | secret | OpenAI project key | forwarding to api.openai.com |
| CODE_GATEWAY_PRICES | config (not secret) | owner-chosen price table JSON | cost estimate per call; missing = all calls refused |
| CODE_GATEWAY_PER_CALL_CAP_USD | config | owner-chosen number | per-call cap; missing = refused |
| CODE_GITHUB_TOKEN | secret | GitHub token/App credential | verifying the workflow run that calls the gateway |
| CODE_TARGETS | config | the one-repo allowlist (jackboy-dev-control@main + pinned SHA) | narrows the stored allowlist; mismatch fails closed |
| SUPABASE_URL | public | Lovable Cloud project URL | database address |
| SUPABASE_SERVICE_ROLE_KEY | secret | Lovable Cloud only; not exposed to owners | every read/write of controls, reservations, audit, Emergency Stop |
| VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY / VITE_SUPABASE_PROJECT_ID | public | build-time values | app build |

Railway currently has only CODE_PROVIDER_API_KEY, JACKBOY_LINK_ORIGIN and OMNI_LINK_*; the six other rows above are missing there. The OMNI_LINK_* values are not used by the gateway.

## 2. Is the admin database key required?

Yes. `code-gateway.server.ts`, `code-safety.server.ts` and `code-runner-auth.server.ts` all import `supabaseAdmin` (service role). Spend reservations, the audit/call log, the Emergency Stop check and the allowlist all go through it. Lovable Cloud does not give out that key, so there is no supported way to run this path on Railway as written. Without it, the Railway copy fails closed (refuses every call).

## 3. Applied database changes

This backend tracks migrations in a Drizzle table that the read-only role cannot open, so the version list could not be read directly. Evidence instead:
- The project's migration journal lists 0031 through 0045, including 0043_code_provider_gateway, 0044_omni_sessions and 0045_omni_dispatch_grants.
- The live database contains every table those add: code_runtime_controls, code_spend_reservations, code_provider_calls, code_usage_events, code_provider_cost_day_reports, omni_link_sessions, omni_jobs, omni_inbound_jobs, omni_connection, omni_callback_nonces.
- Earlier history: 0039 was intentionally skipped by the owner, and the OMNI session SQL is recorded under a later number (#44) than its file name.
Conclusion: CODE changes through 0043 and OMNI 0044/0045 appear applied (structurally confirmed); exact version rows unverified.

## 4. Current safety state (code_runtime_controls)

- enabled: false (CODE OFF)
- kill_switch: true (Emergency Stop ON)
- provider_hard_cap_verified: false
- daily_spend_limit_usd: 5.00; per_task_reserve_usd: 1.00
- consecutive_failures: 0; usage_spike: false; no active request or run
- allowed_targets: OMERTA-ROW/jackboy-dev-control, main, workflow SHA ebc71c1…3761
- reconcile grace 900 s; closed-day lag 21600 s; last updated 2026-11-05 21:55 UTC
- Total $10 reservation guard: not present in code, so still unverified. Activation: BLOCKED.

## 5. Recommendation

Run the CODE gateway on Lovable's published app, not Railway. The database and its admin key live here, so the published app already has everything the safety checks need; copying the key to Railway is not possible. Railway can keep serving the OMNI link and anything that doesn't touch the database.

If approved later (separate steps, each needing owner sign-off):
1. In GitHub, set CODE_RUNNER_AUTH_URL to the published Jackboy address.
2. Add CODE_PROVIDER_API_KEY, CODE_GATEWAY_PRICES and CODE_GATEWAY_PER_CALL_CAP_USD in Lovable Project Settings → Secrets (the sandbox shows the last three missing; CODE_GITHUB_TOKEN and CODE_TARGETS exist).
3. Remove CODE_PROVIDER_API_KEY from Railway once unused.
4. Build and test the total $10 guard; then publish only with approval.
Emergency Stop stays ON and CODE OFF throughout.

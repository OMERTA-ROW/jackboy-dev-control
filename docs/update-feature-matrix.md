# Jackboy update & repair feature matrix (internal, vendor-neutral)

Concepts are independently implemented from publicly documented feature ideas; no vendor code, APIs or branding. Status: **Tested** = pure rules with passing tests; **Live** = running against real data; **Gap** = not built.

| Concept | Code path | Status | Next task |
|---|---|---|---|
| Patch catalog, multi-source entries | `src/lib/patch-catalog.ts` | Tested (rules) | Catalog table + GitHub releases collector |
| Vulnerability-prioritized triage (CVSS, known-exploited, age, exposure) | `patch-catalog.ts#priorityScore/triage` | Tested | Trusted advisory feed collector |
| Update rings + deferrals, canary gate | `patch-catalog.ts#ringsOpen` | Tested | Persist rings per device group |
| Staged % rollout, auto-rollback on error rate | `update-server.ts`, `update-server.server.ts` | Live (web targets) | Tie to rings |
| Signed packages / manifests (Ed25519) | `update-server.ts`, `update-targets.server.ts` | Live | Package cache for endpoints |
| Preflight compatibility (OS/arch/version), health, windows, reboots | `endpoint-policy.ts`, `update-policy.ts` | Tested; web targets Live | Feed real client facts |
| Exceptions per group, expiring | `patch-catalog.ts#isExcepted` | Tested | Owner UI on Releases |
| Monitoring thresholds + hysteresis + dedup jobs | `endpoint-policy.ts#stepAlert` | Tested | Telemetry table + Foundry job creation |
| Configurable maintenance jobs (original, signed, allowlisted) | — | Gap | Define job schema; no arbitrary scripts |
| Remediation / code repair | Code Foundry (`foundry*.ts`) | Live (Jackboy repo) | Link catalog items to Foundry tasks |
| Approval / policy | Foundry approvals, `automation-policy.ts` | Live | Single approval for patch jobs |
| Canonical loop order | `patch-catalog.ts#nextStage` | Tested | Drive from hourly tick |
| Connections / scopes | AutoConnect | Live (GitHub, AI) | Device enrollment capability |
| Audit + Razoo outbox | Site Log (`site-log*.ts`) | Live (outbox pending, no endpoint) | Log patch-loop stages |
| Multi-project batch scan/repair/distribute | `batch.ts`, `/projects` | Live (browser-tested) | Rings across projects |
| Device agent (optional, future, not in main workflow) | — | Not planned now | — |
| Compliance reporting | — | Gap | Per-group patched/missing view |

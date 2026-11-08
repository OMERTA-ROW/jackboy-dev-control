# Jackboy autonomy audit — 2026-11-07 16:20 UTC

Read-only live reads plus source review. Nothing was switched on or off.

## Live state
| Area | Switch | Actually running? |
|---|---|---|
| Kill Switch (global) | Off | — |
| Background work (per project) | On for 18 of 19 active projects (10 have a repo) | Only when the owner starts a loop |
| Recurring Foundry inspections | Off, paused | No |
| Autopilot master | Off (3 projects have their own switch on, which does nothing) | No |
| Scheduled fix writer | Held: legacy "Not enough credits" pause | No (last run Nov 2) |
| Hourly job (inspections, Autopilot, Task Mode, log delivery) | Schedule inactive | No (last tick Nov 3) |
| Site monitor schedule | Inactive | No (manual checks only) |
| Phone alerts / morning report schedule | Active every 2 min | Needs publish (no run record yet) |
| GitHub CODE | On, emergency stop released, hard cap marked, meter healthy ($0/$5, $0/$10), 0 failures, 1 allowed site (jackboy-dev-control/main) | Each run waits for owner approval in GitHub |
| OMNI link | Not verified | No build/test handoffs |

## Brief items
1. Autonomous routines — PARTIAL: inspect, repair, draft PRs, history exist; unattended running is off (schedules inactive). Learning = verified pattern counts only.
2. Dashboard — PARTIAL: Classic/Assist toggle was removed earlier at owner request; dismissible notices exist.
3. GitHub — PARTIAL: inventory, branches, draft PRs, check status exist; no issue creation or reviewer-approval summary.
4. OMNI — PARTIAL: signed link accepts only self-test; dispatch off; never grants CODE.
5. Razul — BLOCKED: needs RAZUL_API_URL/RAZUL_API_KEY; no watchers.
6. JAX — STUB: manifests simulated, browser-local; Vault excluded by rule.
7. Chat/voice/activity/cancel/retry — IMPLEMENTED (physical-device voice unverified).
8. Security — PARTIAL → improved: Kill Switch was not enforced by Foundry, Autopilot, update writer or AutoConnect; now enforced at every work entry point (fail closed). `audit_logs` has no immutability trigger (site_log and foundry_events do).
9. Permission separation — IMPLEMENTED as separate lanes; merge/publish/deploy/secrets/billing stay owner-only (Undo revert exception).
10. Duplicates — two GitHub clients and two repair pipelines (update-writer/Autopilot vs Foundry); left as-is.

## Outstanding GitHub gates
Runner acceptance on current main, GitHub App scope reduction, CODE-AUTO environments/ruleset for automatic lane, Workflows write for Add-to-CODE, per-site CODE_TARGETS + passkey pin for any site beyond jackboy-dev-control.

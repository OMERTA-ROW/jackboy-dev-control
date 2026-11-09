# First controlled $1 CODE acceptance test — owner review plan

Plan only. Nothing has been run, reserved, submitted or changed. The owner has not approved the $1 spend.

## Gate check (live records read at 01:36 UTC, Nov 9)

| Gate | Result | Evidence |
|---|---|---|
| CODE switch | PASS (switch only) | `enabled=true`. It has never done real work: 0 reservations, 0 provider calls, 0 usage events. |
| Kill Switch / Work Pause | PASS | `automation_policy.paused=false`, CODE `kill_switch=false`, no stop requested. |
| Leftover runs | PASS | No active request or run; cancellation `not_needed`. |
| Target allowlist | PASS | Only `OMERTA-ROW/jackboy-dev-control` @ `main`, workflow `37368194…`. |
| $1 per task | PASS | `per_task_reserve_usd=1`. |
| $5 daily | PASS | Limit 5; $0 spent today (meter `ok`, no reasons). |
| $10 cumulative | PASS (by design) | Limit 10; $0 committed; staged guard 0046 enforces committed + reserve ≤ limit. |
| Provider hard cap | PASS | `provider_hard_cap_verified=true`. |
| Two-failure stop | PASS | `consecutive_failures=0`; stop rule in place. |
| Spike alert | PASS | `usage_spike=false`; hourly gateway spend $0. |
| Owner passkey | PASS (by design) | On-switch and spend actions require a fresh passkey; not re-tested today. |
| Cancellation | UNVERIFIED | Built and tested in code; never used on a real run. |
| OpenAI cost cross-check | BLOCKED until after test | `provider_costs_synced_at` is empty; 0 closed-day reports. Can only happen after a real call, about 6 hours after the UTC day closes. |
| GitHub run isolation / approval | PASS (by design) | `code.yml` runs only on manual dispatch inside the protected CODE environment, which needs your approval in GitHub. |
| Successful execution | FAIL (not yet done) | No run has ever completed. |
| OMNI build permission | Not needed | Out of scope; stays off. |

No gate blocks starting the test. The cost cross-check can only finish after it.

## Safe test scope
- One request on `OMERTA-ROW/jackboy-dev-control`, `main`, reviewed lane only (no automatic lane).
- A harmless, non-functional change, for example a one-line note in `docs/`. No code, settings, secrets or workflow files.
- Result must be a draft PR only. No merge, no publish.

## Maximum cost
- $1.00 is set aside before anything runs. The money actually used will likely be a few cents.
- Hard ceilings stay as they are: $5 per day, $10 total.

## Evidence to capture
1. Reservation row: $1.00, linked to the request.
2. Provider call rows: model, tokens and cost for each call.
3. GitHub run link, approval timestamp and run logs.
4. Draft PR link, changed files and passing checks.
5. Reservation released, with the leftover returned and today's spend updated.
6. Site Log entries for every step.
7. After the day closes (about 06:00 UTC next day): OpenAI daily cost compared with Jackboy's meter, and no bypass flagged.

## Stop criteria (press Stop, or it stops on its own)
- Any change outside `docs/`, or any write to a workflow, secret or settings file.
- Spend above $1, or a spike alert.
- No progress for 2 minutes while writing (stall warning).
- A failed run (a second failure triggers the automatic stop).
- The cost cross-check showing more than Jackboy recorded. This raises the stop automatically.

## How you approve
1. **Settings → Activation:** start the $1 CODE test, read the scope and the $1 hold, then confirm with your passkey.
2. **GitHub → Actions → CODE run:** "Review deployments" → approve the `CODE` environment.
3. Review the draft PR. Merging stays optional and is up to you.

## Next owner action
When you approve the spend, start the test in Settings → Activation with your passkey, then approve that one run in GitHub. After it finishes, send me the run link so I can check every item on the evidence list.

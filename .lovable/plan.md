# Report: what stops Jackboy from sending work to OMNI automatically

No code changes. I checked this against your saved secrets and the current code today.

## Blockers

1. **OMNI has no address to receive work.** Jackboy expects `OMNI_API_URL` and `OMNI_API_KEY`, and neither is saved. OMNI also has no inbox endpoint that accepts jobs, so a job can't arrive there.
2. **OMNI has no worker to do the fixing.** There's no running OMNI service that picks up a job and edits, tests and returns results. The one OMNI job sits queued with "sent" empty, and Jackboy won't mark it sent until a real worker confirms it.
3. **"OMNI verified" is never switched on.** That flag stays off until a real handshake succeeds. Until then, publish, pricing and sell controls stay locked.
4. **The sending pipe isn't built yet.** The outbox stores pending messages, but nothing delivers them to OMNI, retries failures or reads replies. Razul is first in that line, and its two keys (`RAZUL_API_URL`, `RAZUL_API_KEY`) are also missing.
5. **CODE voice-controlled orchestration (issue #5).** Live voice can create a CODE request card, and you approve it by saying "Allow CODE" plus its ID. After approval, though, nothing hands the job to OMNI, so the job doesn't run. This also needs a real voice call on a device, which has never been verified.
6. **The GitHub App isn't set up.** `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_SLUG` are missing. Jackboy uses your personal token for now, and it can read and change OMERTA-ROW/Omni. That's enough to open draft fixes but not to give OMNI its own scoped access.
7. **No test runner.** GitHub Actions results return "forbidden," and there's no separate place to run tests safely. So a fix can't be proven before review.
8. **No webhook secret.** `FOUNDRY_WEBHOOK_SECRET` is missing, so GitHub/OMNI can't safely call back with "done" or "failed."
9. **Guardian isn't built.** Your rules make Guardian OMNI's top authority, but it exists only as an idea. Nothing can approve OMNI actions on its behalf.
10. **The scheduled jobs only run on the published app.** The latest version isn't published, so the background scans and handoffs don't run on their own.

## What you'd do by hand vs. what I'd build

- **You:** stand up OMNI's job inbox and worker (it's a separate project), then add `OMNI_API_URL`/`OMNI_API_KEY`, the Razul keys, `FOUNDRY_WEBHOOK_SECRET` and the GitHub App keys in Secrets. Then publish.
- **Me, once you approve:** build the delivery pipe with retries, the "done/failed" callback, the step that hands an approved CODE request to OMNI, and the handshake that switches "OMNI verified" on.

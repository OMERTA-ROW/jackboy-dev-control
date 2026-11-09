# OMNI read-only readiness check (01:11 UTC Nov 9)

No changes made. Values never shown. Secret lengths are not reported: that would reveal part of a secret.

| Item | Result | Evidence |
|---|---|---|
| OMNI_LINK_ENABLED exactly `true` | PASS (direct) | Exact match in dashboard settings |
| OMNI_LINK_REMOTE_RUNNER_ENABLED exactly `true` | PASS (direct) | Exact match |
| OMNI_LINK_REMOTE_RUNNER_URL | PASS (direct) | Set; Railway host written without `https://`, which the dashboard reads as `https://` (supported) |
| OMNI_LINK_REMOTE_RUNNER_SECRET, HMAC_SECRET, BOOTSTRAP_KEY, CLIENT_ID, PROJECT_ID | PASS for being set (direct) | All present |
| Railway-only settings left out of the dashboard (RUNNER_MODE, NODE_RUNNER_ENABLED) | PASS (direct) | Both absent, so the earlier cleanup is done |
| Owner approval | PASS (direct) | Valid until 18:28 UTC today |
| Kill Switch | PASS (direct) | Off, so it won't block the self-test |
| Guardian | UNVERIFIED | No live record exists to check |
| Runner secret matches Railway | UNVERIFIED (inference only) | It can't be compared without showing values. Only a signed self-test proves it |

## Remaining blocker
No configuration blocker was found on the dashboard side. The last unproven item is whether the runner secret matches Railway's copy. Only a real self-test can prove that, and you haven't authorized one.

## Next step
When you're ready, authorize one handshake and self-test from OMNI before 18:28 UTC, then send the job ID.

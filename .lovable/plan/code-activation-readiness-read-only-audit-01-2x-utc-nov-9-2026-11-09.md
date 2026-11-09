# CODE activation readiness — read-only audit (01:2x UTC Nov 9)

Nothing was run, changed, merged or deployed. The self-test counts as proof that the connection works. It does not approve any paid work.

## Self-test evidence
- Job 8e387dcf-4443-48bc-980f-f3dad204ebf6: **PASS (direct).** Jackboy's own record shows it as `completed`, created at 01:19:22 and finished at 01:19:26 UTC. The "3 checks passed" result comes from your OMNI screen. Jackboy's record confirms the job finished, not how many checks ran.

## Checklist
| Item | Result | Evidence |
|---|---|---|
| OMNI owner approval | PASS (direct) | Valid until 18:28 UTC today |
| OMNI project scope for CODE work | BLOCKED (direct) | No project permissions exist yet (0 granted). OMNI can run the self-test but can't be given build jobs |
| Work Pause (Kill Switch) | PASS (direct) | Off |
| CODE emergency stop | PASS (direct) | Off, no stop request pending, cancellation not needed |
| Guardian | UNVERIFIED | No live record exists |
| Approved repository list | PASS (direct) | Exactly one repo: `OMERTA-ROW/jackboy-dev-control` on `main`, locked to workflow version `37368194…` |
| Passkey | PASS (by design) | Every on-switch and spending action asks for a fresh passkey. Not tested in this audit |
| $10 total budget | PASS (direct) | Enforced, $0 used, no money reserved |
| $5 daily cap / $1 per task | PASS (direct) | $5.00 per day, $1.00 per task, $0 spent today |
| OpenAI billing cap | PASS (direct) | Marked as verified |
| Daily cost cross-check with OpenAI | BLOCKED (direct) | No OpenAI cost report has ever been synced (0 days). Jackboy's own cost meter works, but its cross-check against OpenAI's billing has never run |
| Two-failure stop | PASS (direct) | 0 failures in a row |
| Spending-spike alert | PASS (direct) | No spike flagged |
| Activity log | PASS (by design) | The log can't be edited, so past entries are kept |
| GitHub test run | BLOCKED (direct) | 0 AI calls and 0 reservations so far, so the controlled $1 test has never run. CODE has no proven run yet |
| Publishing and OMNI connection limits | PASS (by design) | Merges, publishing and deploys still need you. The test runner can't use AI, GitHub or deploys |
| CODE switch | Already ON | It is on but has never actually run. Every run still needs your approval in GitHub |

## Remaining blockers
1. The controlled $1 GitHub test has never run.
2. OpenAI's costs have never been cross-checked against Jackboy's meter.
3. OMNI has no project permission for build work (only matters for sending jobs to OMNI).
4. Guardian has no record to check.

## Single next safe action
Run the controlled $1 CODE test from Settings → Activation (passkey, then approve it in GitHub). Run it only when you're ready to authorize that spend.

Note: plan mode prevents updating roadmap.md. The new audit task will be added once a plan is approved.

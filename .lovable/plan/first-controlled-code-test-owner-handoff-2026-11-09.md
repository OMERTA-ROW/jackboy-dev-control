# First controlled CODE test — owner handoff

Nothing was run, reserved, submitted or changed. Spending is not authorized.

## Does the Settings → Activation "$1 test" button exist?

**BLOCKED.** No such button exists. Settings → Activation only holds the on-switch steps and the stop controls; none of them starts a CODE run. The last plan wrongly pointed you there.

The only working way to start a CODE run today is the **Chat → CODE** task card (`CodeTasks` on `/chat`, through `/api/code`): request → Allow card (passkey) → GitHub dispatch → GitHub environment approval. It does work, but you type the instruction yourself. Nothing limits it to docs, and nothing marks it as the acceptance test.

## Live readiness (rechecked 01:38 UTC)

| Gate | Result | Evidence |
|---|---|---|
| CODE switch | PASS (switch only) | `enabled=true`; never ran |
| Kill Switch / Work Pause | PASS | both off; no stop requested |
| Active run | PASS | none |
| Reservations | PASS | 0 rows, $0 held |
| Caps | PASS | $1 task / $5 day / $10 total |
| Target allowlist | PASS | `OMERTA-ROW/jackboy-dev-control` @ main, workflow `37368194…`; project "Jackboy Dev Control" exists |
| Owner passkey | PASS (by design) | Allow card and switches need a fresh passkey; not tested today |
| GitHub environment approval | UNVERIFIED | Required reviewers on `CODE` were not re-read in this check |
| Docs-only limit | BLOCKED | No such restriction exists in the reviewed lane |
| OpenAI cross-check | Pending | Only possible after a real call |

## Proposed safe fix (needs your approval to build)
1. Add a **"Run $1 acceptance test"** card in Settings → Activation. It is shown only when every gate passes and no CODE run has ever succeeded.
2. It uses one fixed instruction that you can't edit: add a one-line dated note to `docs/CODE-ACCEPTANCE.md`. It always stays in the reviewed lane, never the automatic one.
3. Before it runs, it shows the target, the $1 hold, the caps and the expected draft PR. Your fresh passkey goes to the existing `requestCode` / `decideCode` path, so all current server checks still apply.
4. A server check of the finished change refuses anything that touches files outside `docs/CODE-ACCEPTANCE.md`. A refused or failed result counts toward the two-failure stop.
5. An evidence panel shows the reservation, provider calls, GitHub run link, draft PR, the released hold, Site Log steps and the cost cross-check status.
6. Tests cover: the card is hidden when any gate fails, the instruction is fixed, the lane is always reviewed, and the server rejects any other file.
7. No database change is expected. If one turns out to be needed, I'll stop and ask first.

## Alternative now, with no build
Use Chat → CODE with this exact instruction: "Add one line `Acceptance test <date>` to docs/CODE-ACCEPTANCE.md. Open a draft PR. Change no other file." Confirm the Allow card with your passkey, then approve the `CODE` environment in GitHub Actions. Weakness: nothing enforces docs-only, so you must check the changed files yourself.

## Evidence after the run
- Reservation of $1.00, then released with the leftover returned
- Provider calls with model, tokens and cost
- GitHub run link, approval time and logs
- Draft PR changing only that one doc file, with checks passing
- Site Log steps
- After the UTC day closes (+6h): OpenAI cost matches Jackboy's meter, with no bypass flagged

## Stop criteria
Any other file changed, spend over $1, a spike alert, a 2-minute stall, a failed run, or a mismatch in the cost cross-check.

## Next single owner action
Choose: approve this plan, so I build the locked docs-only test card (no spend), or run the Chat alternative yourself once you authorize the $1.

# Daily report, phone alerts and one-press Undo

These get built after the current queue. That queue is Add project to CODE and the approval lanes, and both are waiting on your approvals. All safety gates, spend limits ($1 per run, $5 per day, $10 total), the Kill Switch and passkey checks stay exactly as they are.

## What already exists

- Every CODE request, approval, run, spend and stop is already recorded in the log, the spending meter and the approval list. The report and alerts can be built only from those real records.
- There's an in-app notice list, but nothing sends it anywhere. Email shows "not configured" because no sender domain is set up.
- Undo exists only for the older update proposals. It doesn't cover CODE changes yet.
- The phone channels you could use are Telegram, Twilio text messages and Firebase push. They're all available in your workspace, but none is linked yet.

## 1. Daily morning report

**What you get:** one short message each morning:
- **Done:** runs finished, draft PRs opened, merges you made, inspections ("Scanned 3 sites, 0 fixes needed").
- **Spent:** yesterday's total, then today's and the overall total against the $5 and $10 limits. If the delayed OpenAI cross-check disagrees with Jackboy's own count, it's flagged.
- **Waiting for you:** passkey steps, GitHub approvals, PRs to merge and blockers, each with a link that opens the page.
- **Safety:** Kill Switch state, CODE on or off, any automatic stops.

A copy is also saved on a new Settings → **Reports** page, so you can read old reports even if a message is missed.

**Rules**
- Only real records. If a source can't be read, the report says "unavailable" and doesn't guess.
- One report per day. A re-run never sends it twice.
- No secrets, keys or code in the message. Links only open the site, and you still sign in and use your passkey there.
- Sending a report never starts, approves or changes anything.

## 2. Phone alerts

**When you get one:** right away when a CODE run waits for your passkey, waits for GitHub approval, hits an automatic stop or a spend warning, or a draft PR is ready to merge.

**What it says:** for example, "Jackboy: Hercules run waiting for GitHub approval (opened 2 min ago)," plus a link. If it's still waiting after 15 minutes, you get one reminder, and then no more.

**Rules**
- Approving never happens from the message. A reply or tap can't approve anything; it only opens the page, where the normal passkey or GitHub step applies.
- Each item alerts once, plus that one reminder. There's a daily cap of 30 alerts, and optional quiet hours (urgent stops still come through).
- A failed send shows "not delivered" in Settings with a Retry button. It's never marked as sent when it wasn't.
- A "Send test alert" button in Settings proves the channel works before it's relied on.

## 3. One-press Undo

Each CODE change gets an **Undo** button on its card. Undo makes no AI calls and costs $0. What happens depends on where the change is:

| Where the change is | What Undo does | Passkey |
| --- | --- | --- |
| Draft PR, not merged | Closes the PR. The branch is kept, so it can be restored. | No |
| Merged into the site's main code | Builds a "revert" change that puts every touched file back to exactly what it was before. It opens as a PR and waits for checks to pass. | Yes, fresh |
| Also published on the live site | Same as above, then shows "Republish needed". Jackboy can't publish for you, and it re-checks the site afterwards. | Yes, fresh |

**Rules**
- Before undoing, Jackboy checks whether anything newer changed the same files. If so, it refuses the one-press undo, shows which files clash, and offers a reviewed fix instead. It never overwrites newer work.
- Every undo is logged with the original change, the revert, who pressed it and the result. Undo can't be pressed twice for the same change.
- It's blocked while the Kill Switch is on, and it only works on sites already on the CODE allowed list.

## Decisions needed from you

1. **Phone channel:**
   - **Telegram:** free and instant. Needs the Telegram app and a bot you create in two minutes.
   - **Text message (Twilio):** about 1¢ per text. Needs a Twilio account and number.
   - **Push notification:** free. On iPhone it only works after you add the site to your home screen.
2. **Report:** time and time zone (for example 7:00 AM Eastern), and whether it goes to the same channel or to email. Email needs a domain you own.
3. **Undo after merge:**
   - **(a)** Jackboy opens the revert PR and you merge it in GitHub, the same as every other change.
   - **(b)** After your passkey, Jackboy also merges the revert itself once checks pass. This is a narrow exception to "Jackboy never merges", limited to undoing its own changes.

## Order

1. Undo for draft PRs, plus the reports page and report text. No new channel is needed.
2. Your chosen phone channel, the test alert, then live alerts.
3. Daily report delivery on a morning schedule.
4. Undo for merged and live changes, including the passkey, the clash check and the republish prompt.

## Technical details

- New pure modules with tests:
  - `daily-report.ts`: builds the report from `site_log`, `action_requests`, `code_spend_meter_status` and the approval state.
  - `owner-alerts.ts`: which events alert, the dedupe key, the reminder, the cap and quiet hours.
  - `code-undo.ts`: decides the undo kind and checks for clashes by comparing each file's blob on main with the merge commit's version.
- Server side:
  - `owner-alerts.server.ts` sends through the chosen connector via the gateway.
  - Alerts are queued in a small `owner_alert_outbox` table: dedupe key unique, status pending/sent/failed, attempts, last error. It's owner-only (RLS) and service-role writes.
  - Reports go in `daily_reports`, unique by date.
- Cron: a managed schedule calls `/api/public/jobs/daily-report` (protected by `authenticateCronRequest`). Pending alerts flush within the existing jobs tick and right after the event is written.
- Undo:
  - Reuses the GitHub helpers in `github.server.ts`. A merged undo builds a `jackboy/revert-*` branch from each file's content at the parent of the merge commit.
  - A new step-up action `code_undo` requires a fresh passkey.
  - Option (a) never calls merge. Option (b) adds an owner-only merge of that revert PR only, gated on passing checks.
- Database changes (two new tables) will be shown for your approval before they're applied, as usual.

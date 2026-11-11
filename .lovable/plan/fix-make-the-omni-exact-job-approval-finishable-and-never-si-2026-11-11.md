# Fix: make the OMNI exact-job approval finishable and never silent

## What I found (read-only, DB time 17:46 UTC)

1. **Why job 8a06c639 shows "Blocked" right now.** The job itself is fine: queued, unsent, Build kind, correct repo, project enrolled, repo matches, access covers Build, Kill Switch off. The *only* failing rule is link freshness. The last successful link check was **17:37:50**; the rule requires one within the last **5 minutes**, so from **17:42:50** the job flipped to "Blocked — OMNI's link check is older than 5 minutes". Queuing it while the link was unverified (17:28) does **not** matter; the rule checks the link at approval time, not at queue time. When Blocked, the "Review this job" button is greyed out (`OmniHandoffPanel.tsx` line 246).
2. **Silent failures.** The review screen catches every error and shows it as one small plain line at the very bottom (`OmniDispatchReview.tsx` lines 35-36 and 203), with no red styling, and the message is cleared when the next action starts. If you cancel the passkey prompt, it may show only "Request not confirmed." Failed preview or approve attempts are **never written to the activity log** (`previewOmniReceipt` ~line 189 and `approveOmniReceipt` ~line 122 in `omni-link.functions.ts` only throw). So a failure leaves no record, which matches what you saw: no step-up row, no grant, no error.
3. **The confusing review screen.** "Review this job" does fill in the Job ID, but it **does not open the review**. It only shows a second screen at the bottom of the panel (line 274), with raw "Job UUID" and "Existing grant UUID" boxes. You then have to click a second button, "Review job", before "Approve exact job with passkey" appears. The 5-minute link window keeps running during all of this. Each step then checks the link again on the server.

## The smallest real fix (no safety rule changes)

- **One-click review:** "Review this job" opens the review right away, scrolls to it, and shows the job details. The raw ID boxes move into a folded "Advanced" section.
- **Link timer and re-check:** the review shows "Link verified at HH:MM — approve before HH:MM". When it has expired, a **"Re-check link"** button runs the existing real link check, and the approve button stays off until the check passes. Blocked jobs also get a "Re-check link" button next to the reason, plus a short note that the 5-minute timer starts from the check.
- **Clear errors:** failures show in a red alert next to the button you pressed, and stay until you dismiss them. A cancelled passkey says "Passkey not completed — nothing was approved."
- **Activity log:** every refused or failed preview or approve writes a `site_log` row (`omni.receipt.preview_failed` or `omni.receipt.approve_failed`) with the job ID, the blocker code and a short reason. It never includes secrets. Successful approval keeps its existing audit.
- No change to the passkey step-up, the 5-minute rule, the Kill Switch, project access, the Mothership approval, v3 sending or legacy paths. No rows inserted by hand.

## Files to change
- `src/components/OmniDispatchReview.tsx`: auto-preview on open, link-time banner, re-check button, red error alert, folded Advanced section.
- `src/components/OmniHandoffPanel.tsx`: scroll to the review; "Re-check link" next to the link_stale blocker.
- `src/lib/omni-link.functions.ts`: wrap preview and approve so failures are logged to `site_log` and still thrown. Return `linkVerifiedAt` with the preview.
- `src/lib/omni-handoff-auth.ts`: small pure helper `linkExpiresAt(verifiedAt)` for the countdown.

## Tests
- `omni-handoff-auth` test: a job is Blocked with `link_stale` exactly 5 minutes plus 1 second after the check, and Ready at 4:59. `linkExpiresAt` equals the check time plus 5 minutes.
- Server test: a refused approve (stale link) and a failed preview each write one `site_log` row with the correct action and job ID, and the error is still raised to the caller.
- Existing safety tests rerun unchanged.

## After the fix (owner steps)
Check connection → within 5 minutes, click "Review this job" → "Approve exact job with passkey" → approve in Mothership → Submit. Expected result: "Verified remote receipt: quarantined". I have not tested this flow live.

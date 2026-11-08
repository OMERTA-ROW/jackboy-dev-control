# Jackboy repair plan: OMNI expiry, buttons, and "Blocked" items

Replaces the earlier navigation plan. Everything below was checked read-only. No values are shown, and nothing was changed, sent or turned on.

## 1. The OMNI approval still shows "Expired" — stale value, not a code bug
- The setting names match on both sides. There is exactly one `OMNI_LINK_APPROVAL_EXPIRES_AT` and one `OMNI_LINK_APPROVAL_ID`, with no misspelled copies.
- The page reads the value fresh on every check. Nothing is cached. The time format includes its zone, so this isn't a time zone problem.
- The value Jackboy holds is readable and ended about **28 hours ago**, so it's yesterday's expiry. The Site Log has recorded "expiry expired" on all four of your panel views (Nov 7, 19:19 to 23:15 UTC).
- **Cause:** today's expiry isn't saved in Jackboy's Secrets, or the live site hasn't been published since you saved it. A changed secret only reaches the live site at the next publish.
- **Your fix:** in Project Settings → Secrets, edit OMNI_LINK_APPROVAL_EXPIRES_AT (and check OMNI_LINK_APPROVAL_ID) with today's values exactly as they are in Railway, then publish once. I then re-check validity only.

## 2. Buttons that look broken — what each one really is
| Button | Diagnosis | Kind |
|---|---|---|
| "Approve and activate with passkey" (Add to CODE) | Greyed out on purpose until every gate passes. The reason is only in a hover tooltip, which phones can't show, so it looks dead. | UI bug |
| "Check connection" (OMNI link panel and handoff panel) | Runs a real link check (a handshake). It will fail while the approval is expired. It is greyed out if link settings are incomplete. | Stale settings, then works |
| "Live link not verified" | True. No handshake has succeeded, and a check only counts for 5 minutes. | Unverified live link |
| "OMNI not connected" heading | Comes from an older, separate status and ignores the new link evidence. | UI/stale data |
| Recheck (agent status, project cards) | Reloads the data. No fault found in the code; I'll verify by clicking it in the preview. | To verify |

## 3. OMNI internal build and Mothership jobs — real blockers
- Both queued jobs (from Nov 1) are type **"code"**. Handoffs only accept **build** or **test** jobs, so they can never be handed over as they are. Both projects do have a GitHub repo linked.
- Other gates also apply: a live link checked in the last 5 minutes, a passkey grant for the project, and the Kill Switch off.
- I won't change, resend or delete them. One option, with your OK: a "Make a build/test copy" button that creates a *new* job, leaving the originals untouched. Or you tell me they should go through CODE instead.

## 4. Add to CODE "Blocked" lines (OMERTA-ROW/Omni)
| Line | Real cause | Who |
|---|---|---|
| Workflow version chosen | No package.json or go.mod at the repo root. The Go code is likely in a subfolder. | Code change (approved Go profile with a fixed subfolder), after you confirm the folder |
| Database ready for several sites | The staged multi-site update isn't applied. | Your separate approval |
| CODE / CODE-PUBLISH approval | GitHub environments missing, or not requiring you on each run. | You, in GitHub |
| Runner address, run-starting credential | Repo variable not set; token doesn't cover the repo. | You, in GitHub |
| CODE_TARGETS / pin | Comes last, after the workflow PR is merged. | You, plus your passkey |

"Autonomous Mode on" doesn't mean these are verified. The hard cap, Emergency Stop, spend limits and GitHub approvals stay as they are.

## Phased fixes (needs your OK)
1. **UI fixes only.** Show the blocked reason as visible text under every greyed button (works on phones). Replace "OMNI not connected" with one live status: last handshake, last refusal, expiry valid/expired with hours. After any check, refresh the status automatically. Add tests.
2. **Refusal reason in the Site Log:** when OMNI is refused, log which check failed, with no values.
3. **Go subfolder support** in Add to CODE, after you name the folder.
4. **Optional "build/test copy"** for the two queued jobs, as new jobs.
5. **Later, separate approvals:** the database update; then your GitHub steps; then publish.

## Your actions now
- Save today's approval expiry (and ID) in Jackboy Secrets, then publish.
- Say which phases to build, and the folder holding OMNI's go.mod.

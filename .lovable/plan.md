# Restore OMNI link panel visibility + audit "Blocked" items

## What I found (source, read-only)
- The "OMNI link values for Railway" panel was not removed. It still sits at the top of the **OMNI page** (`/omni`). The page you were looking at is the **OMNI project page** (Projects → OMNI). That page only shows Repairs and approvals, Open Update Queue, GitHub issues/PRs and Add to CODE. It has no link to the panel.
- Every "Blocked" item in Add to CODE comes from one checklist that reads GitHub and the database live. Each blocker matches a real missing condition. None is a display bug.

## Part 1 — make the OMNI link panel easy to find (safe source change)
1. On the OMNI project page, add a small "OMNI link" card near the top. It shows value-free status only: owner ID valid or invalid, approval valid or **expired**, link switch read, and last handshake or refusal from the Site Log with its time. It links to "Show values with passkey" on `/omni`. Revealing values still needs the same fresh passkey.
2. Add "OMNI link" to the Settings page list and to the Activation panel's OMNI step, so the panel is reachable from all three places.
3. Fix the stale status wording. Retire the old "OMNI not connected" heading in favor of one status line built from live evidence: newest handshake, newest refusal, approval expiry. When no evidence exists, it reads "Not tested".
4. Optional, waiting on your earlier OK: when OMNI is refused, write one Site Log line naming which check failed (for example "approval expired" or "link switch off"), with no values. This is the fastest way to confirm the 01:54 refusal cause.
5. Add tests for the status wording: an expired approval shows Expired, and an old handshake never shows Connected.

## Part 2 — "Blocked" audit (Add to CODE, OMERTA-ROW/Omni)
| Item | Real cause | Fix | Who |
|---|---|---|---|
| Workflow version chosen | The repo root has no package.json or go.mod. OMNI's Go module is likely in a subfolder. | Code: add subfolder Go detection (a pinned working directory in the approved Go profile), plus a test. This must stay an approved profile, never auto-guessed. | Me, after your OK |
| Database ready for several sites | Staged multi-site pin update (`staging/code-sites/0050_code_site_pins.sql`) is not applied. | Review it, then apply it only on your explicit approval, with its rollback ready. | You approve |
| CODE / CODE-PUBLISH environment approval | The GitHub environment is missing or doesn't require you on each run. | GitHub → Omni repo → Settings → Environments: add yourself as required reviewer, turn on Prevent self-review, turn off admin bypass. | You |
| Runner address | `CODE_RUNNER_AUTH_URL` repo variable is missing or wrong. | Set it to the value shown on the card. | You |
| Run-starting credential | `CODE_GITHUB_TOKEN` can't see the Omni repo. | Add the repo to the token with Actions read/write. | You |
| CODE_TARGETS / pin | Comes only after the workflow PR is merged. | Update the secret through the secure form, then a fresh passkey pin. | You, last |

Other "Blocked" items found elsewhere (readiness panel: runner acceptance, App permissions, deployment-to-commit, backup/restore) are owner or evidence gates and stay blocked until real evidence exists. I'll list each one with its exact fix inside the card rather than changing any of them.

## Not changed
No migrations, secrets, publish, handshake/self-test, jobs, CODE/autonomy toggles, passkey, hard-cap or emergency-stop changes. Part 1 reaches the live site only when you publish.

## Approvals needed from you
1. OK to build Part 1 (and say whether to include item 4, the refusal reason in the Site Log).
2. OK to build subfolder detection in the Go profile (Part 2, row 1). Please confirm the folder that holds OMNI's go.mod.
3. Separately, when ready: approve applying the multi-site database update.

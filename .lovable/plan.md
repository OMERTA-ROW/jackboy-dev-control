# Add Orbiting Minds Mothership to CODE (draft PRs only)

## Short answer
No new app code is needed. Jackboy already has an "Add project to CODE" flow (Settings, CODE site card) that does exactly this, and Mothership is already in your project list linked to `OMERTA-ROW/orbiting-minds-mothership`. The allow list holds up to 10 sites; today it has Jackboy only. All existing gates (passkey, Emergency Stop, Kill Switch, $5/day, $10 total, $0.50 per call, $1 per job, one job at a time, two-failure stop) apply per run regardless of repo and are not touched.

## What happens in the app (with you)
1. Open the CODE site card for "Orbiting Minds Mothership" and press **Prepare**. Jackboy opens a draft PR on branch `jackboy/code-onboarding` in Mothership containing only the approved Go workflow and validation script (`.github/workflows/code.yml` plus its check script). It never merges.
2. You review and merge that PR in GitHub (regular merge commit).
3. Save the new `CODE_TARGETS` value the card shows (it lists both repos, each on `main` with its pinned workflow version) through the secure form.
4. When every checklist line is green, press **Approve and activate with passkey**. This pins Mothership in the database. Jackboy's own pin is not changed.

## What you must do outside the app (GitHub, step by step)
1. **GitHub App access:** github.com, OMERTA-ROW org, Settings, GitHub Apps, Jackboy app, Configure, Repository access: add `orbiting-minds-mothership`. It needs Contents: Read & write and Pull requests: Read & write. If it lacks Workflows: Read & write, either grant it or copy the workflow file into the onboarding branch yourself (the card shows the file).
2. **Run-starting token:** edit the fine-grained token stored as `CODE_GITHUB_TOKEN` and add `orbiting-minds-mothership` with Actions: Read & write (Contents: Read). No new Jackboy secret needed.
3. **Environments in the Mothership repo:** Settings, Environments, create `CODE` and `CODE-PUBLISH`. On each: add yourself as required reviewer, turn on "Prevent self-review", turn off admin bypass. Do NOT create `CODE-AUTO` or `CODE-PUBLISH-AUTO`, so every run stays reviewed.
4. **Repo variable:** Settings, Secrets and variables, Actions, Variables: `CODE_RUNNER_AUTH_URL` = the value the card shows. No AI key or other secret goes into the Mothership repo; AI calls go through Jackboy's capped gateway.
5. **Branch rule for main (recommended):** require pull requests and allow only "Allow merge commits" under Settings, General, Pull Requests (untick squash and rebase).
6. Leave the per-site automatic switch OFF in Jackboy for Mothership.

## Keeping Mothership's sandbox quarantined
- CODE runs on GitHub's runner against a checkout: it edits files, runs the repo's own checks and opens a draft PR. It never deploys or calls Mothership's live services.
- Before the first task, I will confirm (read-only) that the Go validation script only runs build/vet/tests and nothing that starts the PR #28 workspace sandbox. If Mothership's tests would launch it, the first task stays blocked and I will report back before any change.
- First task to send: "Finish PR #28 sandbox", draft PR only, against the PR #28 branch's base on main.

## Approvals
- You: GitHub steps above, merging the onboarding PR, saving CODE_TARGETS, passkey activation, approving each CODE run, merging every draft PR.
- No database change, migration, publish or safety-control change.

## Cost
Onboarding itself makes no paid AI call. Each later task is capped at $1 per job and $5 per day as today.

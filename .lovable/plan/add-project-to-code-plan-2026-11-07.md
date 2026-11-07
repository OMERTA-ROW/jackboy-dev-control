# Add project to CODE — plan

## What you'll get
Open a project (for example Hercules) and press **Add to CODE**. Jackboy then:
1. Runs read-only checks on that repo: is it in the GitHub App install, does it have a lockfile and build/test scripts, which workflow version fits it.
2. Opens a **draft PR** in that repo on a `jackboy/code-onboarding` branch. The PR adds the approved CODE workflow plus the three helper scripts it needs. The workflow is byte-for-byte the version you approved for that kind of project.
3. Prepares the allow-list entry: repo, `main`, and the workflow blob SHA. That SHA comes from the file's contents, so it stays the same after the merge and Jackboy can check it exactly.
4. Shows a checklist. Each line says Done, Waiting for you, or Blocked, with the fix.

Then you:
- Merge the PR in GitHub.
- Do the one-time GitHub settings and the CODE_TARGETS paste (see "What's needed").
- Press **Re-check**. When every line passes, press **Approve and activate with passkey**. Only then does the pin go live and CODE can run on that site.

**Remove from CODE** (passkey) takes a site off the list again. The history stays.

## Safety gates that stay exactly as they are
- Nothing goes on the allow list without a fresh passkey press. The database checks the passkey grant again. Activation never happens by itself.
- Activation is refused unless all of these are true:
  - the workflow on `main` matches the prepared SHA,
  - CODE_TARGETS includes the entry,
  - the repo's CODE and CODE-PUBLISH environments require you as reviewer,
  - the dispatch credential can see the repo.
- The same $5/day, $10 total and $1-per-task limits apply. Still one task at a time across all sites, the two-failure stop, the Kill Switch and Emergency Stop.
- Every run still needs your approval in GitHub. Writes go only to `jackboy/*` branches. Jackboy opens draft PRs only and never merges.
- Every step is written to the audit log and Site Log.

## What's needed before I build (your decisions)

**1. Permission to add workflow files (blocker).**
GitHub refuses to let the OMERTA-ROW App create files in `.github/workflows` without the "Workflows" permission. This already blocked the `gpt-6-luna` PR. Options:
- **A (recommended):** you add "Workflows: Read & write" to the App in GitHub and accept the updated install. Jackboy's own code would still only write the exact approved workflow bytes, only on `jackboy/*` branches, as a draft PR.
- **B:** keep the App as it is. Jackboy opens the PR with the scripts only. The checklist gives you the workflow file and a link to add it yourself in GitHub (one extra step per site).

**2. CODE_TARGETS can't be saved by the app (one paste per site).**
CODE_TARGETS is a backend secret. Apps can't change secrets while running; that's what makes it an independent second lock. Jackboy will show the exact new value, and I can open the secure form here for you to paste it. Choose:
- **A (recommended):** keep the full entry (repo + branch + SHA), as today.
- **B:** CODE_TARGETS lists only repo + branch, and the SHA pin lives only in the database behind your passkey. Workflow updates then need no new paste, but the second lock no longer checks the workflow version.

I will not remove CODE_TARGETS. That would weaken a safety gate.

**3. GitHub settings per repo (you do these; the App has no admin rights, and that's on purpose).**
- Environments **CODE** and **CODE-PUBLISH**, each with you as required reviewer.
- Repo variable `CODE_RUNNER_AUTH_URL` = `https://jackboy-dev-control.lovable.app`.

Jackboy checks all of this without changing anything. Important: if the CODE environment doesn't exist, GitHub creates it on the first run *without* reviewers. So activation stays blocked until Jackboy confirms you are the required reviewer.

**4. Run-starting credential.** `CODE_GITHUB_TOKEN` currently covers only Jackboy Dev Control. You'd add each new repo to it in GitHub, with Actions read & write. Jackboy checks access without starting a run.

**5. A database update (needs your approval before I apply it).**
- A new onboarding record per site: prepared, waiting for merge, ready, active or removed.
- A new passkey action, "Add site to CODE".
- Update the activation and pin rules, which currently name only Jackboy Dev Control, so they accept several pinned sites.

I'll prepare it with a rollback file and show it to you first.

**6. Workflow versions for other kinds of projects.**
Today's workflow is specific to Jackboy: it runs Jackboy's own CODE tests. I'd create two reviewed versions:
- **Lovable web app (bun):** isolated typecheck and build, plus tests when the project has them. "No tests" is reported honestly.
- **Go (for OMNI):** go vet, test and build in the same isolated container.

You approve each version once. Its SHA becomes the pin for every site of that kind. A project with no lockfile or no build script is shown as Blocked with the fix.

**7. Which site first.** OMNI is your top priority, but it needs the Go version. I suggest piloting with one bun site (Hercules or Mothership), then OMNI. This also widens your saved rule "CODE target is Jackboy only" to "pinned sites you approve one by one". I'll save that once you confirm.

## Build order (after your answers)
1. Database update (staged, your approval, then applied). Allow several pinned sites in the safety rules. The global caps don't change.
2. Workflow versions with the isolation acceptance check; you review them in a Jackboy PR.
3. The Prepare step: read-only checks plus the draft PR. Prepare doesn't need a passkey, because it only opens a draft PR.
4. Re-check and the checklist, then passkey activation and removal.
5. Tests for every rule:
   - no activation without a passkey,
   - SHA mismatch blocks,
   - missing reviewer blocks,
   - an entry missing from CODE_TARGETS blocks,
   - limits are unchanged,
   - removal keeps history.

## Technical details
- New `src/lib/code-onboarding.ts` holds the pure rules: checklist, states and gate reasons. `code-onboarding.server.ts` handles GitHub reads and the PR through the existing `repo-workspace.server.ts`. `code-onboarding.functions.ts` holds owner-only server functions.
- UI: an "Add to CODE" card on the project page, plus a per-site list in Settings → Autonomous Activation next to the existing controls.
- `restrictCodeTargets` changes from "exactly Jackboy" to "only entries present in both the database and CODE_TARGETS". Runner claims keep checking the repo, branch, workflow ref and workflow SHA from the GitHub identity token, per site.
- Hardcoded Jackboy-only checks in `code-safety.ts`, `safety-status.server.ts`, `code-workflow-readiness.ts`, `readiness.server.ts` and the 0049 activation function become per-site.
- Not changed: spend meter, hard-cap gate, Kill Switch, Emergency Stop, single active task, GitHub environment approvals.

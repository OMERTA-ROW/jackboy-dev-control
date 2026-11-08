# Task Mode add-on: two approval lanes for CODE runs

Today every CODE run waits for you twice in GitHub: once before the run (environment `CODE`) and once before the draft PR (environment `CODE-PUBLISH`). This plan adds an **automatic lane** for small, low-risk runs. The **reviewed lane** stays exactly as it is for everything else. Merging still always needs you, in both lanes.

## How it would work

```text
Request ──> Jackboy picks the lane BEFORE starting (server rules, logged)
              │
   low-risk ──┤──> CODE-AUTO (no reviewer) ──> patch + tests
              │         └─> Jackboy re-checks the ACTUAL patch
              │               ├─ still low-risk ─> CODE-PUBLISH-AUTO ─> draft PR (no click)
              │               └─ risky ─> run stops; re-run in the reviewed lane
   other ─────┴──> CODE (your approval) ─> CODE-PUBLISH (your approval) ─> draft PR
```

- **Jackboy decides the lane, not the workflow.** The lane is stored with the request before it starts. When the runner asks Jackboy for its one-time pass, Jackboy checks that GitHub's signed run identity names the same environment. If a run claims the automatic lane but wasn't given it, it's refused and logged.
- **Second check on the real result.** After the AI writes the patch, Jackboy looks at the actual changed files and line counts. A run can't talk its way into the automatic lane.

## What counts as low-risk (all of these must be true)

- The site is on CODE, and you switched the automatic lane on for that site with your passkey. It's off by default.
- The task is a read-only inspection or a small fix.
- The run fits the $1 hold, today's $5 limit and the $10 total limit.
- The patch changes at most 3 files and 50 lines, and every build and test passes.
- It touches none of these: workflows, database migrations, `.env` or secret-like values, dependency and lock files, sign-in/passkey/permission code, payment code, CODE's own safety code. It deletes no files.
- The Kill Switch is off, the site isn't in a two-failure stop, and fewer than 3 automatic runs have happened on that site today.

Anything else goes to the reviewed lane. Unknown means reviewed.

## Exactly what you'd change in GitHub (Jackboy changes nothing there)

Do this per repository, starting with `OMERTA-ROW/jackboy-dev-control`.

**Step 0 — Check your plan allows it.** GitHub only offers required reviewers on private repositories with GitHub Enterprise. On Free, Pro or Team plans they work on public repositories only ([2](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)). Repo → Settings → Environments → `CODE`: if you see "Required reviewers" with your name, you're fine. Nothing below weakens that.

**Step 1 — Create `CODE-AUTO`.**
1. Repo → Settings → Environments → **New environment** → name `CODE-AUTO` → Configure.
2. Leave "Required reviewers" and "Wait timer" **off**.
3. "Deployment branches and tags" → **Selected branches and tags** → Add rule → `main`.
4. Add **no** environment secrets and **no** variables.

**Step 2 — Create `CODE-PUBLISH-AUTO`** the same way: no reviewers, `main` only, no secrets or variables.

**Step 3 — Don't touch `CODE` or `CODE-PUBLISH`.** They keep required reviewers, "Prevent self-review" on, and admin bypass off.

**Step 4 — Protect `main` (strongly recommended).** Repo → Settings → Rules → Rulesets → **New branch ruleset**:
1. Target: default branch.
2. Turn on **Require a pull request before merging**, with 1 required approval.
3. Turn on **Block force pushes** and **Restrict deletions**.
4. Bypass list: only you.

This guarantees nothing from either lane reaches `main` without you.

**Step 5 — Approve the workflow change.** Jackboy prepares a draft PR that picks the environment per lane. You review it and merge it yourself. Workflow files are owner-only by your rules.

**Step 6 — Re-pin.** That merge changes the workflow version. Save the new `CODE_TARGETS` value through the secure form, then approve the new pin with your passkey. Both steps already exist.

**Step 7 — Turn it on in Jackboy.** Settings → Autonomous Activation → per-site **Automatic lane** switch, with a fresh passkey. The Kill Switch overrides it.

## Safety review this needs

1. **Forged lane.** Anyone holding the run-starting credential could try to start the automatic lane. GitHub's signed run identity must name `CODE-AUTO` or `CODE-PUBLISH-AUTO`, and the request must have been given that lane before it started. Tests prove a mismatch is refused.
2. **The patch can't classify itself.** The risk check runs in Jackboy on the patch's file list and line counts. The workflow's own label is never trusted.
3. **No secrets in the automatic environments.** The readiness check fails if either one has secrets, variables, reviewers on the wrong one, or branches other than `main`.
4. **Spend and rate.** Same limits as today, plus at most 3 automatic runs per site per day. Two failures stop the site; spend spikes trip the Kill Switch.
5. **Trial period first.** For the first week Jackboy only labels runs "would have run automatically" while everything still goes through review. You read that log before switching it on.
6. **Undo.** An automatic run can only open a draft PR on a `jackboy/*` branch. Closing the PR undoes it, and nothing deploys.
7. **History.** Lane decision, reasons, patch size, cost and outcome go to the Site Log and audit log.

## Alternative (not recommended now)

A **custom deployment protection rule**: Jackboy's GitHub App approves low-risk runs on one environment and holds risky ones until you approve in Jackboy with your passkey. It needs Enterprise for private repositories, is still in public preview ([4](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/configure-custom-protection-rules)), and would add Deployments permission to the App.

## Build order (after you approve)

1. Rules and tests: lane choice, the patch re-check, the protected-path list, the daily cap. Then trial-mode labeling only.
2. Read-only readiness checks for the two new environments, plus a per-site "Automatic lane" switch (fresh passkey, off).
3. Draft PR for the workflow change. You merge it, re-save `CODE_TARGETS` and re-pin.
4. A staged database update for the lane field and the daily cap, applied only with your separate OK.

## Technical details

- `code.yml`: the execute job uses `environment: ${{ inputs.lane == 'auto' && 'CODE-AUTO' || 'CODE' }}`. The publish job reads a `lane` output from validate, choosing `CODE-PUBLISH-AUTO` or `CODE-PUBLISH`.
- `code-runner-auth.server.ts`: the expected subject and `environment` claim come from the stored lane (`resources.lane`). The publish stage recomputes the risk from the reported changed files and line counts before issuing a pass.
- New pure module `code-lane.ts` with tests. Readiness and onboarding checklists read all four environments. `enable_code_runtime` gates stay unchanged.

# CODE for every OMERTA-ROW repository (draft PRs only)

## What exists today
- CODE runs only on repos listed on a pinned allow list (max 10). Each listed repo needs its own copy of the CODE workflow, its own `CODE` / `CODE-PUBLISH` approval environments, and a passkey pin. Today only Jackboy is pinned. Mothership is already in your project list.
- All money limits ($0.50 per call, $1 per job, $5 per day, $10 total, one job at a time, stop after 2 failures) are already shared across all repos, not per repo. They stay unchanged.

## The key point
GitHub approval environments and workflows are per repository, so "one setup for every repo" is only possible if CODE runs from one central place. The plan does that:

```text
Jackboy repo (one workflow, one CODE approval environment)
   -> checks out the target OMERTA-ROW repo with a short-lived App token
   -> edits, runs that repo's checks, opens a DRAFT PR in that repo
```

New repos are covered automatically; nothing is added inside them.

## Changes to build (after you approve)
1. **Org rule instead of a list:** a repo is allowed when its owner is exactly `OMERTA-ROW`, it is not archived, its default branch is `main`, and it is not on your block list. Any other owner is refused.
2. **Owner-only block list:** add/remove a repo with your passkey; logged. Blocked repos are refused before any spending.
3. **Central runner:** the Jackboy CODE workflow takes the target repo as an input, re-checks the org rule and block list, gets an App token limited to that one repo (contents + pull requests only), and opens a draft PR. The workflow itself stays pinned by your passkey as today, so the "pin" safety now protects the one central workflow instead of each repo.
4. **Quarantine:** CODE only edits code and runs build/lint/tests. A fixed deny rule stops any command that starts the Mothership workspace sandbox until you mark PR #28 merged with your passkey. Nothing deploys.
5. **Tests:** other owner refused; blocked repo refused; new unlisted OMERTA-ROW repo allowed; archived or non-main refused; spend caps combined across two repos; no merge path exists; sandbox start refused.
6. Small database change for the block list and org rule (needs your approval as a migration). No other gate changes.

## What you do on GitHub
1. **Jackboy GitHub App:** OMERTA-ROW org, Settings, GitHub Apps, Jackboy, Configure, Repository access: **All repositories**. Permissions: Contents Read & write, Pull requests Read & write, Metadata Read. Not needed: Workflows, Administration, Secrets.
2. **Jackboy repo only:** keep the existing `CODE` and `CODE-PUBLISH` environments with you as required reviewer, self-review prevented, no admin bypass. No per-repo environments, workflows, variables or secrets anywhere else.
3. **Merge style, per repo (or org ruleset):** org Settings, Rulesets, new branch ruleset for all repos, target `main`: require a pull request, allowed merge method "Merge commit" only.
4. **Copilot coding agent:** optional and separate from Jackboy. It is a paid GitHub product and won't make Jackboy work. If you still want it: org Settings, Copilot, Policies, enable "Copilot coding agent", then Coding agent, Repository access: All repositories. I recommend leaving it off to keep the budget tight.

## Approval stays everywhere
You approve each run (GitHub environment plus Jackboy card), Jackboy opens draft PRs only, you merge with a regular merge commit. Jackboy never merges.

## Needs your OK
- This plan (it changes the CODE allow-list rule recorded in the project rules).
- The small block-list migration.
- No publish until you say so.

# OMNI Mothership simplification: UX audit and proposal

Planning only. Nothing gets deleted, disabled, published or deployed. Credentials stay as they are, Emergency Stop stays ON and CODE stays off.

## What is known vs unknown
- Known: Jackboy lists "Orbiting Minds Mothership" (repo `OMERTA-ROW/orbiting-minds-mothership`) as a saved project. The GitHub App install guidance includes that repo.
- Not verified this session: whether the App can currently read or write that repo, and what the Mothership's screens and modules actually are. Jackboy has no access to the Lovable project. Any inventory before Phase 0 is a guess, so this plan doesn't include one.

## Phase 0: Read-only inventory (needs owner OK to read the repo)
1. Check the App's access to the Mothership repo: read yes/no, write yes/no.
2. If reading is allowed, list every route/page, module, nav item, demo/sample screen, and where API keys are handled. Each is listed with its path, a plain one-line purpose, a label (real, demo or unknown), and the permission it needs.
3. Save the inventory as a dated report in Jackboy, linked from the Site Log. If the repo can't be read, stop and report the blocker.

## Phase 1: Proposal document (no code)
- Map every inventoried item into 5 home sections: Dashboard, AI Agents, Projects, Connections / API Keys, Settings / Security. Anything else goes under "More" (collapsed).
- For each tool: a one-line explanation and one clear "Next step".
- Demos: tag them "Demo", hide them from the owner's default view, and add a "Show demos" switch. Nothing is removed.
- Add breadcrumbs, a mobile bottom nav with the 5 sections, global search over the inventory, and a "Jackboy ↔ OMNI onboarding" progress card. The card shows real states only: storage, settings, link server, self-test. It never shows a fake "connected".
- Keep a route-preservation table: every existing URL still works (redirect or same path).

## Phase 2: Implementation as one draft PR (owner approval required)
Done on a `jackboy/omni-ux-simplify` branch in small commits:
1. Navigation shell and the 5 sections, with "More" collapsed.
2. Descriptions and Next-step text.
3. Demo labeling and the hide switch.
4. Breadcrumbs, mobile nav and search.
5. Onboarding progress card, read-only.

Existing tests must pass before the draft PR. Add tests for: all routes still reachable, demos hidden by default but available via the switch, and no permission checks removed. Jackboy never merges; the owner reviews and merges.

## Blockers
- Mothership repo access through the App is unconfirmed (write was previously denied to the personal token).
- The Mothership's Lovable project can't be reached from here, so its preview can't be checked visually until it's deployed by the owner.
- CODE stays off, so changes are prepared through the normal supervised draft-PR path, not autonomous runs.

## Owner approvals needed
1. OK to do the Phase 0 read-only inventory of `OMERTA-ROW/orbiting-minds-mothership`.
2. After reviewing the Phase 1 proposal: OK to open a draft PR (Phase 2).
3. Merge and publish of the Mothership stay entirely yours.

# OMNI Mothership UX audit and simplification proposal

Date: 2026-11-06 (UTC). Source: read-only snapshot of Lovable project "Orbiting Minds Mothership", commit `88930ff7` (666 files). Nothing in that project was changed. This is a proposal only.

## Findings
- The main menu (`src/components/SiteNav.tsx`) has **63 items** in one flat list: 3 featured items plus 60 under "More".
- **26 items** have "Demo", "Simulation", "Synthetic" or "Concept" in their label, and they appear right next to real tools.
- API Keys sits at `/omni-api-keys`, item 13 of 60, labelled "API Keys · Owner". It is easy to miss.
- Of the 73 public route files, 54 mention demo/sample/mock content. Private pages are under `_authenticated/`: beta, beta-omni, members, invite, account-security, knowledge-brief, quantum-studio.
- There are no breadcrumbs and no one-line descriptions in the menu, and Home sits in the same list as everything else.

## Proposed owner home: 5 sections
| Section | Existing routes (all kept) | One-line purpose | Next step |
|---|---|---|---|
| Dashboard | `/launch-control`, `/security-report`, `/releases`, `/updates`* | See what needs you today | Open the top item |
| AI Agents | `/omni`, `/omni-razul`, `/omni-agents`, `/omni-models`, `/agents`, `/embassy`, `/care-agent` | Your agents and the models they use | Check agent status |
| Projects | `/beta`, `/beta-omni`, `/code-exchange`, `/challenges`, `/open-call`, `/pathway` | Projects you own or were invited to | Pick a project |
| Connections / API Keys | `/omni-api-keys`, `/omni-gateway`, `/sdk`, Jackboy↔OMNI onboarding card (new) | Add and check keys and links | Add or verify a key |
| Settings / Security | `/account-security`, `/members`, `/invite`, `/guardian`, `/trust`, `/omni-rights`, `/omni-legal` | Who can sign in and what they can do | Review security |

\* Demo pages stay at their current address but are listed under "More → Demos".

**More (collapsed, searchable):** `/mothership`, `/universe`, `/discovery`, `/digital-twin`, `/robotics`, `/knowledge-fusion`, `/knowledge-brief`, `/quantum-studio`, `/marketplace`, `/compute-grid`, `/partnerships`, `/roadmap`, `/sandbox`, `/platform`, `/omni-marketing`, `/angel-tech`, `/pulse`.

**More → Demos (hidden until "Show demos" is turned on):** `/command-nexus`, `/omnibridge`, `/entertainment`, `/cartoon-galaxy`, `/code-vault`, `/commons`, `/agent-lounge`, `/incident-archives`, `/agent-debrief`, `/guardian-incidents`, `/report-incident`, `/physical-safety`, `/experiment-replay`, `/approval-ledger`, `/impact-scorecard`, `/care`, `/updates`, `/pilot`, `/voice`, `/devices`, `/fleet`, `/dashboard`, `/arena`.

No route, permission or record is removed. Every URL keeps working.

## Phased checklist
- [x] Phase 0: read-only inventory (this document)
- [ ] Phase 1: owner reviews the section mapping above
- [ ] Phase 2a: nav config with 5 sections plus collapsed More and a "Show demos" switch (default off, remembered per user)
- [ ] Phase 2b: one-line description and Next step for every item
- [ ] Phase 2c: breadcrumbs, mobile bottom nav (5 icons), search in the existing command palette
- [ ] Phase 2d: Jackboy↔OMNI onboarding card that shows real states only (storage ✓, settings ✓, link server pending, self-test pending)
- [ ] Tests: every old route is still reachable, demos are hidden by default, auth guards are unchanged

## Blockers
- Jackboy can only **read** this Lovable project. Changes must be made in the Mothership project's own chat, or through a draft PR to `OMERTA-ROW/orbiting-minds-mothership` once the GitHub App's write access to that repo is verified.
- The snapshot was not opened in a browser, so the visual layout is unverified.

## Owner approvals needed
1. Approve or adjust the section mapping.
2. Choose how to implement it: in the Mothership's own chat (paste Phase 2 there) or as a Jackboy draft PR (needs App write access verified first).
3. Merge and publish remain the owner's decision.

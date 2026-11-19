# Task agent and CODE approval design (PROPOSED)

Status: proposal only. Nothing here is built, enabled or approved. Written from the owner's goals on 2026-11-19. Not legal, tax or financial advice. Mirrors the owner's Notion page "OMNI Task Agent: capability roadmap and CODE design".

## Goal

A task agent inside OMNI/CODE that does real tasks for the owner (social posts, podcast and content generation, music publishing paperwork, case filing prep, movie, music and game editing, research and admin). CODE remains the coding lane. Other integrations plug into the same task agent later.

## Decision: CODE approval-only, task agent limited autonomy

- CODE: the owner approves each request with a passkey, Jackboy opens a draft pull request, the owner reviews and merges. CODE never merges, deploys or runs on its own. Autonomy for CODE stays paused.
- Task agent: low-risk tasks may run inside preset limits (spend caps, short permit, Stop). Irreversible steps always stop for the owner's final click and passkey.
- Autonomy stays off until tested on a harmless task first.
- The current block on real CODE jobs is Jackboy's own spend-cap rule (`provider_hard_cap_verified`, migration 0037), not GitHub. This document does not change it. Changing it is a separate owner-approved step.

## Link-based approvals (proposed)

1. Jackboy sends the owner a link (push, text or email) when a job needs approval.
2. The link opens the exact approval card: what the job will do, cost cap, expiry.
3. The owner approves with a passkey on that page. A link alone never approves anything.
4. The link is single-use, bound to one job, and expires quickly.
5. The same page shows the result afterward (draft PR, draft post, draft document) for review.

This must reuse existing rules: alerts only link to on-site pages and never approve (see `owner-alerts*.ts`), permits stay the sole authority (`omni-permit*.ts`), and unreadable safety state fails closed.

## Risk tiers

- Tier 0: read-only (research, summaries, status checks).
- Tier 1: drafts (post drafts, scripts, forms filled but not submitted, edits exported as new files).
- Tier 2: reversible actions (schedule a post that can be cancelled).
- Tier 3: irreversible, legal or financial (e-filing, tax filing, payments, publishing that cannot be undone). Always a human final click plus passkey. The agent never holds passwords or IDs.

## Task lanes

1. Coding (CODE, exists): repo change to draft PR.
2. Social posting and tags: draft, approve, schedule through a connected scheduling app.
3. Content generation (podcasts and similar): script, audio, show notes; publish only after approval.
4. Music publishing: metadata, registrations, split sheets and release paperwork as drafts; human submits.
5. Documents and case filings: collect, organize and draft; human reviews and files.
6. Movie, music and game editing: prepare edits and exports as drafts; originals are never overwritten; owner approves before publishing.
7. Browser and screen tasks (portals, e-filing): only in a dedicated sandbox with strict limits; stops before final submit.
8. Research and admin: Tier 0.

## Task flow

1. Task spec: goal, allowed tools and accounts, limits, deadline.
2. Plan card: steps in plain language.
3. Approval: passkey, exact scope, expiry.
4. Run: each step checked against the permit and limits; Tier 3 steps pause for the owner.
5. Evidence: audit log, outputs, cost. Result card says what was done and what was not.

## Prerequisites

- Verified provider daily spend cap (or a gateway that enforces it) before any paid task runs.
- OMNI CODE-specific claim and publish contract before routing CODE or task jobs through the executor.
- Credential vault design with scoped, revocable credentials held by Jackboy, never in chat or notes.
- Sandbox for browser and screen tasks.
- Legal and compliance review before any filing-related lane.

## Proposed phases

- 5b: CODE disposable-repo tests (GitHub-only, no secrets, no spend), then spend-cap work.
- 6: Task agent MVP: social post draft and scheduling with approval, plus link-based approvals.
- 7: Content and podcast generation.
- 8: Music publishing and document prep, human files.
- 9: Editing lanes and sandboxed browser tasks, stop before submit.

## Open decisions for the owner

- First task to build.
- Accounts and apps to connect, and their budgets.
- Where credentials live.
- Who approves.
- Whether to turn the CODE setting Off until Phase 5b.

# Jackboy tester release: assessment and surfacing plan

This is an assessment only. Nothing has been deployed or changed.

## Current safe state (checked in the live database)
- Emergency pause is ON (`automation_policy.paused = true`)
- Scheduled Foundry runs are OFF
- Autopilot is OFF
- OMNI connection is unverified
- 35 Foundry tasks are stored, and none run on their own
- The recovery-code table and the CODE safety columns are not in the database yet (updates 0036–0039 have not been applied)

## Capabilities by status

**Working now, can be shown to testers as view-only or permission-gated**
- Sign-in with email/password, Google and Microsoft; account and security pages; authenticator app (TOTP); passkeys; signed-out protection
- Projects list, project details, multi-select, Add Site, site connectivity checks, Connect/Resync review with passkey approval
- Approvals queue, Blocker Queue, Site Log (permanent record, export), Logs & Approvals
- Code Foundry history and quality metrics (read-only view)
- GitHub App and token status panels, repository review
- Chat in text mode (same tools and approval checks as the buttons)
- Releases, channels and feature switches (view)

**Built but needs a test before it's shown as working**
- GitHub sign-in through Auth0: the button reaches Auth0, but no full sign-in has been finished and passkey linking isn't built
- Live two-way voice: works only in a simulator so far, and the call timed out; needs a real device
- Draft PR creation: verified once for OMNI through the GitHub App; CI and Actions results can't be read yet
- Recovery codes: code exists, but its database update hasn't been applied

**Placeholder or not connected (label it "Not connected")**
- OMNI worker (job queued, never sent, not hosted), JAX (simulated), RA'SUL (no API configured), Guardian (concept only), Discovery (no sources), Research (needs a search key), test runner, Notion sync, browser repair, Mac Helper

## Proposed surfacing (after approval)
1. Add a "Preview / not active" badge and disabled state to every action control whose backend isn't verified (OMNI send, CODE run, Autopilot ship, scheduled runs, Releases rollout, Evolution decisions). The controls stay visible but don't run anything.
2. Add a short capability page in Settings listing each feature as Working / Needs testing / Not connected, built from the real connection state.
3. Leave emergency pause, passkey gates, the owner-only checks on the server, and invitation-only access unchanged. Add no automatic execution.

## Remaining blockers before publishing
1. Owner decision to apply database updates 0036–0039. The preview and the published app share one database, so applying them affects both.
2. The Auth0 tenant allows public sign-up. Close it, or accept that new accounts arrive with no role.
3. Run a security scan and resolve any critical findings.
4. Webhook delivery to the published site has only been checked in preview, so it needs publishing and a redelivery to confirm.
5. Owner approval to publish. Nothing is published until you say so.

## Technical notes
- The disabled state uses one shared `PreviewGate` wrapper that reads server-derived capability flags (`agent-manifest.ts`). The server keeps its own checks, so the UI flag is never the only guard.
- No migrations, secrets, schedules or CODE flags are touched by the surfacing work.

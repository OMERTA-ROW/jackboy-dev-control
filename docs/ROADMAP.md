# OMNI, Evolution, and Honeycomb Roadmap

This document records the intended roles, safety boundaries, and delivery
sequence for OMNI and the applications that use it. It is a roadmap, not
evidence that a live integration or capability is enabled.

## Roles

- **Evolution (Mothership)** — the home base and dashboard, hosted in Lovable as
  Orbiting Minds Mothership.
- **OMNI** — the intended shared, sandboxed code-execution engine and coding
  agent for OMNI, Jackboy, and future agents. It will provide its own chat and
  terminal experience, similar in workflow to Claude Code or Codex. OMNI is
  deployed from this repository on Railway.
- **Jackboy Dev Control** — the dispatcher and gatekeeper for
  `OMERTA-ROW/jackboy-dev-control`, responsible for approvals, passkeys, and
  spend limits.
- **Honeycomb Terminal** — a separate, branded mobile app that will use OMNI
  over the secure link.

## Current reported state

The following is the supplied operational summary, not an independent live
verification:

- Railway deploys OMNI from `main`. The image builds `omni-inbox` by default;
  `omni-link` is intended only for an owner-approved one-off.
- `OMNI_LINK_*` settings are reported as configured on Railway and Jackboy.
  Their approval expires approximately every 24 hours.
- The full self-test is blocked: the live Jackboy service cannot run its
  runner, and the Railway Jackboy copy cannot reach Jackboy's data. A fix is
  being planned.

## Safety and contribution rules

- Lovable owns Jackboy's `main` branch. Copilot changes are made on branches and
  submitted as pull requests; do not push changes directly to `main`.
- Never put secrets in source code, comments, or chat.
- Untrusted code may run only in a separately reviewed, isolated sandbox.
- Nothing autonomous is enabled by default.
- Spend limits are **$1 per task, $5 per day, and $10 total**. Enforcement must
  be verified before execution is enabled.
- Owner approvals remain required for privileged operations. Jobs must not
  merge to `main`, deploy, read or change secrets, or raise their own limits.
- Any approval-based autonomous grant must be time-limited, passkey-approved,
  and expire automatically.

## Roadmap

1. **Complete secure-link validation.** Run the handshake test, fix the
   full-self-test blocker, run the full test, and close #5 only after the
   required checks pass.
2. **Review sandbox isolation design.** Write the isolation design document
   and obtain owner review before implementing an untrusted-code runner.
3. **Build the guarded sandbox runner.** Add agent identities and scopes,
   per-agent budgets, a bounded job queue, append-only audit records, and
   global and per-agent stop controls. Keep the runner disabled until its
   isolation, limits, and secure-link gates are reviewed and verified.
4. **Add Mothership controls.** Provide OMNI chat and terminal, an agents view,
   and a per-agent autonomous-mode switch backed by passkey approval and
   auto-expiring grants.
5. **Connect Honeycomb Terminal.** Integrate it with OMNI over the secure link
   with passkey protection, automatic lock, shared sessions, and mobile
   approvals.

Each phase is subject to owner review and its required safety checks. A roadmap
item does not authorize running the self-test, enabling a flag, activating
autonomous execution, or deploying a change.

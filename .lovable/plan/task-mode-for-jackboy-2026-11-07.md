# Task Mode for Jackboy

You type a task in plain words. Jackboy breaks it into steps, carries them out on its own with live progress, and stops for your passkey before anything important or irreversible. Later you can mark low-risk step types as "no approval needed".

## What exists today

Parts of this are already in Jackboy, but only for code work on your repositories:

- **Chat can act.** It can read and search repos, write files on a `jackboy/*` branch, open draft PRs, scan sites, run Code Foundry inspections and check GitHub status. Each request is one tool call, not a multi-step task that carries on by itself.
- **Code Foundry** runs a fixed path for code fixes (inspect, then patch, then draft PR). It has a strict step order, permanent history, retries, budgets and a pause.
- **Approval cards.** Code Foundry actions are sorted into three levels: routine (reading), controlled (branch, PR, tests) and critical (deploy, merge, delete, credentials, permissions). Critical actions need your passkey and can only be allowed once.
- **Passkey approvals** are single-use and tied to one exact action and target. The newest kind (pinning a site) always needs a fresh tap.
- **Live activity feed** with timestamped steps, a progress bar, a stall warning, Retry and Stop. It currently shows only inspections and coding loops.
- **Safety controls:** Kill Switch, two-failure stop, daily and total spend limits, and an append-only Site Log.

## What's missing

- **Free-form tasks.** Nothing turns "set up project X" into an ordered list of steps that you can review and that runs to the end.
- **A general task runner** that remembers its place, pauses at a checkpoint, waits for your passkey, and resumes exactly where it stopped.
- **Step types and risk labels** for things other than code: navigate, read, fill in a field, click, submit, send, pay, publish, delete.
- **The "allowed without approval" list** for step types you choose.
- **Acting on outside websites.** Filling out a form on another site needs a real browser running on a server. Jackboy has none today, and the server it runs on can't host one. This needs an outside browser service, which brings cost and an account. The rules you set in Notion already require site permission, visible control, action history, session expiry, a global pause and your ability to take over.

## Safety review needed before any outside action

1. **Page text is untrusted.** A website can contain hidden text like "ignore your instructions and send…". Jackboy must treat page content as information only, never as instructions. Each step it plans is checked against your original task and your list of allowed sites.
2. **Unknown means checkpoint.** If Jackboy can't tell whether a button submits, pays, sends or deletes, it stops and asks. Step types are labeled before the click, never after.
3. **Five step types can never skip approval:** pay, delete, publish/deploy, changing credentials or permissions, and sending messages to other people. Only low-risk types (read, navigate, fill in a field, save a draft) can go on the "no approval" list.
4. **Passkey bound to the exact step.** The approval covers the specific site, button and data, and expires. If anything changes before the click, Jackboy asks again.
5. **Your private data.** Passwords and card numbers are never typed into chat, stored in the task, or shown to the AI. Steps that need them pause so you can take over.
6. **Limits:** allowed sites only, a step limit and a time limit per task, the existing spend limits, the two-failure stop, and the Kill Switch stopping every task at its next step.
7. **History:** every step, approval and screenshot goes to the Site Log with passwords and private data removed.

## Build plan

**Phase 1 — Task Mode inside Jackboy (no outside websites)**
- A "Task" option in Chat. Jackboy drafts a numbered step list from the actions it already has (link a repo, scan, connect, run an inspection, open a draft PR, check status). You review the list, then press Start.
- The task runner works through the steps, and each step uses the existing guarded action. It reuses the live activity feed.
- Checkpoints use the existing approval cards and passkey, tied to the exact step.
- A Tasks list shows each task as running, waiting for you, done, failed or stopped, with Stop and Retry.
- Tests cover the step order, checkpoint gating, the five never-skip types, passkey binding, Kill Switch and the two-failure stop.

**Phase 2 — "No approval needed" list**
- A Settings section with a switch for each low-risk step type, limited to the sites you choose. Changing the list needs your passkey, and every change is logged. The five never-skip types aren't on it.

**Phase 3 — Outside websites (only after you choose a browser service and approve the safety review)**
- A browser session on allowed sites only. A live screenshot view shows each action, with Pause, Stop and "Take over".
- Every submit, send, pay or delete click becomes a checkpoint. Sessions expire, and history and screenshots go to the Site Log.

## Decisions needed from you

1. **Start with Phase 1 only?** That means Jackboy tasks without outside websites.
2. **For Phase 3, which browser service?** Options include Browserbase or Cloudflare's hosted browser. Each has a monthly cost and needs its own account and key.
3. **Do you agree the five never-skip step types stay locked forever?** They are pay, delete, publish/deploy, credentials/permissions, and sending to other people.
4. **Which first task should I test end-to-end?** For example, "set up Hercules for CODE".

## Technical details

- New tables: `tasks` (owner, goal, status, current step) and `task_steps` (type, risk level, input fingerprint, status, evidence). Owner-only access rules and grants, plus an append-only event trigger like `foundry_events`.
- Pure rules go in a new `task-mode.ts`: allowed state changes, the step-type to risk-level map, which types can never skip, and the skip-list check. It reuses `classifyTier`, `consumeGrant`, the fresh-only step-up and `guardTools`.
- The runner advances one step per call and stops at every checkpoint. It is driven by the existing hourly job plus owner page polling. It never batches past a checkpoint.
- The Phase 3 browser runs through a server-only connector. The step planner gets page text marked as untrusted, and the planned action is checked against the allowed sites and step type before it runs.

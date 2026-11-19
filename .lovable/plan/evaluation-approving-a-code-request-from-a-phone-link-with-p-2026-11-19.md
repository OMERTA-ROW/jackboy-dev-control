# Evaluation: approving a CODE request from a phone link (with passkey)

Nothing is built by this plan. It answers (a) to (e) and suggests the smallest safe design.

## (a) What the code does today
- `decideCode(id, nonce, decision, userId, sessionHash)` in `src/lib/code.server.ts` is called from two places: `src/lib/code-api.server.ts` (sessionHash = `codeSessionHash(bearer token)`) and `src/lib/live-relay.server.ts` (voice).
- `codeApprovalError` in `src/lib/code.ts` refuses the decision if it's not pending, it has expired, `requested_by` isn't you, or `resources.sessionHash` isn't the calling session's.
- Next, the nonce must match `nonce_hash`. Allowing also re-checks the target (repo/ref/workflow/base SHA), `assertAcceptanceScope` and `verify(p)`. Then one compare-and-swap (pending → allowed/denied, same requester, same nonce, not expired) picks a single winner. `codeSafetyBlockReason` is checked again right before the one GitHub dispatch.
- No passkey step at all. Your description is accurate, with one correction: the nonce lives only in the original browser's session storage. A phone never has it, so a grant **cannot be bound to the nonce**. The grant has to stand in for both the session and the nonce, bound to the request id.

## (b) Files, functions, migration
- `src/lib/step-up.ts`: new action `code_decide_remote` (owner only), added to `FRESH_ONLY_ACTIONS`.
- `src/lib/code.ts`: a pure `codeRemoteApprovalError(row, userId, now)`. It's the same as `codeApprovalError` minus the session check.
- `src/lib/code.server.ts`: new `decideCodeWithPasskey(id, decision, userId, grantId)`.
  1. Check the row with `codeRemoteApprovalError`.
  2. Do the same target, acceptance and `verify` checks as today.
  3. Call `consumeGrant(grantId, userId, "code_decide_remote", "code:<id>", { requireFresh: true })` right before the compare-and-swap.
  4. Compare-and-swap on id + pending + requested_by + not expired (no nonce), and audit it as `remote_passkey`.
  5. Re-check safety and dispatch exactly like today. Best done by extracting today's tail into a shared private helper with no change to its behaviour.
  - `decideCode` itself stays unchanged.
- `src/lib/code-api.server.ts`: new op `decide_remote` (owner bearer still required).
- Card page `src/routes/_authenticated/approvals.$requestId.tsx` and `src/lib/approval-card.server.ts`: Allow/Deny buttons on pending CODE cards, using the existing passkey prompt with action `code_decide_remote` and target `code:<id>`. Opening the page still writes nothing.
- **No migration.** `step_up_grants.action` is free text with no check rule, grants are written and consumed by existing server code, and `action_requests` already has every column needed.

## (c) Risks
- **CODE gates and lanes:** unchanged as long as the remote path reuses the same checks and the same dispatch tail. The main risk is copying that tail and letting the two drift. Extracting one shared helper prevents it, and tests cover both paths.
- **Losing the session tie:** a stolen owner login alone still can't approve, because a fresh passkey from your device is required. That's stronger than today's session tie. Deny also asks for a passkey, so the rule stays the same both ways.
- **Two decisions racing (original session vs. phone):** the compare-and-swap on `status = 'pending'` still lets only one win. The loser gets "stale, expired, or already used".
- **Passkey used up on a refusal:** consume it only after every app-side check passes, right before the compare-and-swap, the same order as the Emergency Stop fix. A refusal from the compare-and-swap after that still uses it up and gets audited.
- **Kill Switch, CODE setting, Emergency Stop:** only read, never written. `verify`, `codeSafetyBlockReason` and the database runner gate still block. The page also keeps the buttons off when the Kill Switch is on or can't be read.
- **OMNI permits, spend caps, migration 0037, Activation:** not touched. CODE dispatch doesn't go through OMNI permits.

## (d) Without a migration, spend caps or 0037?
Yes. It needs no migration, no change to spend-cap rules or migration 0037, no lane change and no OMNI permit change.

## (e) Recommended smallest safe design
The grant replaces the session and nonce on a separate function. Only the owner can use it, it's bound to `code:<request id>`, used once, and must be a fresh passkey check (the existing short expiry). The original path keeps exactly today's code. Tests, one per rule:
1. No passkey → refused, nothing written.
2. Grant for another request id → refused.
3. Grant reused → refused.
4. Another account → refused, even with its own grant.
5. Kill Switch on (or Emergency Stop engaged) → refused, no dispatch.
6. Expired or already-decided request → refused, and the passkey is not used up.
7. Original session path → unchanged (existing tests keep passing).

Nothing merges or deploys. Dispatch only starts the existing draft-PR workflow, as today.

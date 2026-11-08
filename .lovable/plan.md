# Jackboy: replace demo features with real ones, and audit every button

This replaces the navigation-only plan and builds on the approved repair plan (Nov 8). It covers remaining work only. Nothing turns on payments, CODE runs, autonomous work or outside actions. Emergency Stop, the hard cap, passkeys and approvals stay exactly as they are.

## A. What is really "demo" today (checked in the code)
| Area | What's fake now | Safe production fix | Needs |
|---|---|---|---|
| OMNI page: handoff list (top of `/omni`) | Saved only in this browser, so other devices never see it, and its approve/provenance steps are not real records. | Store handoffs in your account (owner-only) and import this browser's list once, with one press. The real build/test handoff panel below it stays as it is. | **Your approval for one database update** |
| JAX page (release manifests) | Saved only in this browser; marked "simulated", revenue shown as none. | Same: store in your account. The "simulated / no revenue" labels stay until JAX and payments are really connected, because those labels are true. | Same database update; payments stay off |
| Discovery page | Example items saved only in this browser. | Hide the examples by default, behind "Show examples". Real fetching needs a scheduled source fetch. | Later: your choice of sources |
| Overview, Activity, Workspace pages (old local log and suggestions) | Browser-only log and suggestion list, separate from the real Site Log. | Show the real Site Log and the real approval queue instead; old local entries stay readable under "Older local notes". | No approval needed |
| Fleet "Simulate" button | A real dry-run of the safety check, but the name suggests it's fake. | Rename it to "Dry-run safety check". Behavior unchanged. | None |
| "Remove Demo" in project findings | A real feature that finds demo text in your *other* sites. | Keep it. | None |

Rule kept: existing browser-only records are never silently made into shared data. The import is one press by you, and the browser copy stays until the import succeeds.

## B. Button and status audit
I'll press every button below in the preview, signed in as you, and record what happens. Anything that does nothing or gives no visible result gets fixed.
| Button / status | Today | Fix |
|---|---|---|
| Recheck (agent status, project cards) | Reloads; no visible "done" message | Show "Checked at HH:MM", or the error |
| Check connection (OMNI worker + handoff panel) | Real check; fails while the approval is expired; the raw result is shown as code text | Plain result text; refresh status after |
| Approve and activate with passkey (Add to CODE) | Greyed out until all gates pass, which is correct; the reason is shown under it | Also show which line is blocking, with a jump link |
| Passkey prompt | Built last round | Re-test every passkey button opens the prompt and ends in success, failure or cancel |
| Live link not verified / OMNI status | True | Keep as is; it clears on a real successful handshake |
| Queued OMNI internal build + Mothership jobs | Type "code", so handoff refuses them | Leave untouched. Offer an optional build/test copy as new jobs, which needs your OK |
| Status refresh | Some panels load once only | Refresh on page focus and after every action, the same pattern as the readiness panel |

## C. Stays blocked until you act (not a bug)
- **OMNI link:** save today's approval expiry and ID in Jackboy Secrets, then publish.
- **Add to CODE for Omni:** tell me the folder with go.mod; set up GitHub environments, the runner address and token access; approve the multi-site database update.
- **Payments / JAX revenue:** off until a real payment provider is connected and verified.
- **Scheduled background runs, credit hold:** your separate decision, as before.

## Build order (after you approve)
1. Section B fixes and the Overview/Activity/Workspace switch to real data. No database change.
2. Fleet rename, and hiding the Discovery examples.
3. Ask your approval, then apply the database update for OMNI handoffs and JAX records, with the one-press import.
4. Browser test signed in as you; run the full test suite; report what passed and what's still blocked.

Nothing is published, no keys change, and no jobs run.

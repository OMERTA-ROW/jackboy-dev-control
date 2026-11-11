# Answer: sending one v3 test job to OMNI (read-only check, 05:43 UTC Nov 11)

Nothing was changed. This is an answer to a question, not a build plan. Approving it does nothing.

## 1. Which settings this project can see (names only)
- JACKBOY_DISPATCH_V3_ENABLED: **visible**
- OMNI_DISPATCH_ORIGIN: **NOT visible**
- OMNI_DISPATCH_CLIENT_ID: **NOT visible**
- OMNI_DISPATCH_HMAC_SECRET: **NOT visible**
- OMNI_DISPATCH_CALLBACK_CLIENT_ID: **NOT visible**
- OMNI_DISPATCH_CALLBACK_SECRET: **NOT visible**
- OMNI_DISPATCH_ENABLED (Jackboy side, also needed): **NOT visible**

The five settings you added don't appear in this project's Secrets list. They may have been saved to a different project, or under slightly different names. Please check Project Settings → Secrets for this project.

## 2. Where to send the job (Jackboy site → OMNI page)
1. Open **OMNI** in the main menu. Press the **check-connection** button at the top. The link has to show as live.
2. Under **Project access**, find the project and tick **Build** or **Test**. Then press **Give OMNI access with passkey**.
3. Under **Waiting build & test jobs**, pick the job and press **Review this job**. Then press **Approve exact job with passkey**.
4. Approve the same job separately in OMNI Mothership. The site tells you to do this.
5. Open the approved handoff with **Open approved handoff** and press **submit**. Later, use **status** to refresh the result.

## 3. What must be in place first (live database check)
| Requirement | State |
|---|---|
| Live OMNI link session | **BLOCKED**: the last session expired Nov 9 01:24 UTC. Run a new handshake. |
| Saved OMNI approval | **BLOCKED (likely)**: it expired Nov 9 18:28 UTC, so it needs owner renewal before a handshake. |
| Project authorization | **NOT YET**: none exists. Step 2 above creates it. |
| Job grant | **NOT YET**: 0 grants. Step 3 creates it, and it lasts up to 30 minutes. |
| Allowed repo | **UNVERIFIED**: neither project has a repo address stored. OMNI_ALLOWED_REPOS is set, but I can't read its value. |
| A waiting job | **PASS**: 2 queued build jobs exist and were never sent. |
| Jackboy dispatch settings | **BLOCKED**: see section 1. JACKBOY_DISPATCH_V3_ENABLED and OMNI_DISPATCH_ENABLED must both be exactly `true`. |
| Global Kill Switch | **PASS**: off. |
| CODE | Disabled. That's fine, because v3 sending doesn't need CODE turned on. |
| Emergency Stop | **BLOCKED**: still on. v3 sending is refused while it's on, so you'd have to release it separately. |
| Publish | Needed. The latest v3 fixes reach the live site only after you publish. |
| Mothership approval | Required on OMNI's side. **UNVERIFIED** from here. |

## 4. Expected result with OMNI's worker off
- If OMNI_DISPATCH_ENABLED is **off on OMNI**, OMNI should refuse the submit. You'd see an error message on the OMNI page, and **no job status would be saved**. You won't get "quarantined" in this setup.
- If you turn OMNI's dispatch on but keep the worker off, the job should stop at **quarantined**. That's the expected value: I haven't seen it happen, because no job has been sent.
- Where to see it: OMNI page → the scoped (v3) jobs section, which shows status, pass/fail, summary and output. The same status appears in chat. If no result came back, the page says so.

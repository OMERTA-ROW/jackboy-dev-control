# CODE live spending meter and owner on-switch (Nov 7, 2026)

Status: built and tested in isolated databases. The database part is **staged, not applied**
(`staging/code-activation/0049_code_spend_meter_and_activation.sql`, rollback beside it).

## Why the meter counts the gateway, not OpenAI
- A task may only start if spending was measured in the last 5 minutes. OpenAI's cost report is
  daily and arrives hours late, so it can never satisfy that.
- Every CODE provider call must first be admitted by Jackboy's gateway, which records it before the
  call is sent. That record is the only real-time source.
- Measured today = the larger of:
  - gateway today: each call created today at its worst case (finished = actual cost, aborted = $0,
    anything uncertain = its full ceiling), plus the unused part of any open task reservation;
  - OpenAI's reported cost for today.
- The meter refuses (and clears the 5-minute stamp) when: the $10 guard is not enforced; measured
  today + one task's $1 hold would pass the daily limit; gateway spending in the last hour reaches half
  the daily limit; a usage spike is recorded; a call cost more than its ceiling in the last 24 hours;
  a past day with CODE calls (older than yesterday) has no OpenAI closed-day report; or OpenAI reported
  more than $0.01 above what the gateway admitted on such a day (possible bypass).
- Only `refresh_code_spend_meter()` can stamp freshness. Jackboy calls it when a CODE request is made,
  when it is dispatched, and when the runner claims the task.

## OpenAI cross-check
Settings → CODE → "Check a past day against OpenAI" fetches OpenAI's report for the oldest waiting day
(or yesterday), records it, and compares it with the gateway. A mismatch engages the Emergency Stop.
It reads OpenAI's free cost-report endpoint; it is not a model call. Days CODE ran must be checked by
the end of the following day, or new tasks are blocked.

## Owner on-switch
Settings → CODE → "Release CODE stop and turn CODE on with passkey". Needs a new passkey check every
time (no reuse), and every check must pass first: CODE off with Stop on, no task running, two-failure
stop clear, no spike, any stopped run confirmed finished, hard cap marked verified, $10 guard with room
for one task, healthy meter, global pause off, workflow pins matching GitHub, gateway settings present
and OpenAI cost-report settings present. The database re-checks its share under a lock and refuses any
other way of turning CODE on. It also clears the old stop marker that would otherwise block every
provider call after an Emergency Stop. To turn CODE off, use "Engage emergency stop" (never blocked).

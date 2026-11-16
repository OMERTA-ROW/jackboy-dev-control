# Executor settings check (read-only, no values shown)

| Setting | Present | Looks right? |
|---|---|---|
| OMNI_AUTONOMY_REVIEWED_RELEASE | Yes | Matches what the code requires (`omni-bounded-plan-1`) |
| OMNI_EXECUTOR_ORIGIN | Yes | **Will be refused.** It is https with no path, but the host is not one the code accepts |
| OMNI_EXECUTOR_PERMISSION_SECRET | Yes | OK: at least 32 characters |
| OMNI_EXECUTOR_PERMISSION_TOKEN | Yes | OK: allowed characters, 32–256 long |
| OMNI_EXECUTOR_CONTROL_SECRET (extra) | Yes | OK: at least 32 characters |

## Why the origin fails
`executorRequest` in `src/lib/omni-execution.server.ts` accepts only one of these:
- a public Railway address `https://<name>.up.railway.app` with nothing after the host;
- the exact private address `http://omni-autonomous-executor.railway.internal:8080`;
- an address that exactly matches `OMNI_EXECUTOR_STAGING_ORIGIN`. That setting does not exist.

The current value is none of these. Because of that, configure and arm will fail. With the change published at 09:11, Mothership should now see that as a signed `execution_control_unavailable` reply instead of "contract mismatch".

## Next step (owner)
Pick one fix:
- Set OMNI_EXECUTOR_ORIGIN to the executor's `https://<name>.up.railway.app` address, with nothing after it.
- Or, only if the executor really is a separate staging host, add OMNI_EXECUTOR_STAGING_ORIGIN with exactly the same value.

## When settings take effect
Changed settings do not need a code change. The site was published at 09:11 UTC and reports no unpublished changes, but a setting changed after a publish is not guaranteed to reach the live site until the next publish. Publish once after fixing the origin to be sure.

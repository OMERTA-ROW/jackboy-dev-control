// Two-failure stop for OMNI bounded jobs (owner rule: stop after 2 failures). Pure rule, no I/O.
// CODE runs already stop through code_runtime_controls.consecutive_failures; OMNI bounded jobs
// finish through omni_execution_control and did not count failures anywhere, so this closes that gap
// at job authorization. The owner's next Jackboy authorization (passkey) is the reset point.

export const OMNI_FAILURE_STOP_AFTER = 2;

export type FinishedJob = { state: string; finished_at: string | null };
export type FailureHistory = { since: string | null; jobs: FinishedJob[] } | null;

/** Returns a refusal reason, or null when a new job may be authorized.
 * - Unreadable history (null) fails closed.
 * - Only jobs finished after the newest owner authorization count.
 * - Cancelled jobs (owner/Stop) are neither failures nor successes; a completed job resets the run. */
export function omniFailureStopReason(history: FailureHistory): string | null {
  if (!history || !Array.isArray(history.jobs)) return "failure_stop_unreadable";
  const since = history.since === null ? Number.NEGATIVE_INFINITY : Date.parse(history.since);
  if (Number.isNaN(since)) return "failure_stop_unreadable";
  const finished = history.jobs
    .filter((j) => j.state === "completed" || j.state === "failed")
    .map((j) => ({ state: j.state, at: j.finished_at === null ? NaN : Date.parse(j.finished_at) }));
  // A finished job without a readable finish time cannot be ordered: fail closed.
  if (finished.some((j) => Number.isNaN(j.at))) return "failure_stop_unreadable";
  let consecutive = 0;
  for (const j of finished.filter((j) => j.at > since).sort((a, b) => b.at - a.at)) {
    if (j.state !== "failed") break;
    consecutive++;
  }
  return consecutive >= OMNI_FAILURE_STOP_AFTER ? "failure_stop" : null;
}

// Pure rule for the global Kill Switch (automation_policy.paused).
// The Kill Switch overrides every per-project and master toggle: when it is on, or its state cannot be read,
// no Jackboy work starts (fail closed). Read-only reporting (alerts, daily report, logs) is not "work".

export const KILL_SWITCH_ON = "Kill Switch is on — all Jackboy work is paused.";
export const KILL_SWITCH_UNREADABLE = "Kill Switch state could not be read — work is held until it can (fail closed).";

export function globalPauseReason(row: { paused?: unknown } | null | undefined, readFailed: boolean): string | null {
  if (readFailed || !row || typeof row.paused !== "boolean") return KILL_SWITCH_UNREADABLE;
  return row.paused ? KILL_SWITCH_ON : null;
}

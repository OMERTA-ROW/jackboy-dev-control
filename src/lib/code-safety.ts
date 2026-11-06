export const CODE_DAILY_SPEND_LIMIT_USD = 5;
/** Cumulative ceiling across every reservation and recorded provider cost, ever. */
export const CODE_TOTAL_SPEND_LIMIT_USD = 10;
export const CODE_MAX_CONSECUTIVE_FAILURES = 2;
export const CODE_USAGE_MAX_AGE_MS = 5 * 60_000;

export type GithubCancellationState = "active" | "confirmed" | "completed" | "unverified";

export function classifyGithubCancellationState(
  status: unknown,
  conclusion: unknown,
): GithubCancellationState {
  if (status === "completed") return conclusion === "cancelled" ? "confirmed" : "completed";
  if (["queued", "in_progress", "waiting", "pending", "requested"].includes(String(status))) {
    return "active";
  }
  return "unverified";
}

export type CodeTarget = { ref: string; workflowSha: string };
export type CodeSafetyState = {
  enabled: boolean;
  killSwitch: boolean;
  allowedTargets: Record<string, CodeTarget>;
  activeRequestId: string | null;
  consecutiveFailures: number;
  dailySpendLimitUsd: number;
  providerSpendTodayUsd: number | null;
  providerUsageAt: string | null;
  providerBudgetEnforced: boolean;
  reservedHoldsUsd: number | null;
  perTaskReserveUsd: number | null;
  usageSpike: boolean;
  /** Database-reported cumulative guard; null when the guard is not installed or unreadable. */
  totalSpendGuard: { enforced: boolean; limitUsd: number; committedUsd: number } | null;
};

export function parseCodeTargets(value: unknown): Record<string, CodeTarget> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CODE target allowlist is invalid.");
  }
  const entries = Object.entries(value);
  if (entries.length > 10) throw new Error("CODE target allowlist exceeds 10 repositories.");
  const targets: Record<string, CodeTarget> = Object.create(null) as Record<string, CodeTarget>;
  for (const [repo, value] of entries) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !value || typeof value !== "object") {
      throw new Error("CODE target allowlist contains an invalid repository.");
    }
    const target = value as Record<string, unknown>;
    if (
      typeof target["ref"] !== "string" ||
      !/^[\w./-]{1,100}$/.test(target["ref"]) ||
      target["ref"].includes("..") ||
      typeof target["workflowSha"] !== "string" ||
      !/^[a-f0-9]{40}$/.test(target["workflowSha"])
    ) {
      throw new Error(`CODE target for ${repo} is invalid.`);
    }
    targets[repo] = { ref: target["ref"], workflowSha: target["workflowSha"] };
  }
  return targets;
}

export function codeStartBlockReason(
  state: CodeSafetyState,
  repo: string,
  now = Date.now(),
): string | null {
  if (state.killSwitch) return "CODE emergency kill switch is engaged.";
  if (!state.enabled) return "Supervised CODE mode is disabled.";
  if (!Object.hasOwn(state.allowedTargets, repo))
    return "Repository is not in the owner-managed CODE allowlist.";
  if (state.activeRequestId) return "Another CODE task is already active.";
  if (state.consecutiveFailures >= CODE_MAX_CONSECUTIVE_FAILURES) {
    return "CODE paused after two consecutive task failures.";
  }
  if (state.usageSpike)
    return "CODE is paused because provider usage exceeded the spike threshold.";
  if (
    !state.providerBudgetEnforced ||
    state.providerSpendTodayUsd === null ||
    !Number.isFinite(state.providerSpendTodayUsd) ||
    state.providerSpendTodayUsd < 0 ||
    !state.providerUsageAt
  ) {
    return "CODE is blocked because authoritative provider spending data is unavailable.";
  }
  const measuredAt = Date.parse(state.providerUsageAt);
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(measuredAt) ||
    new Date(measuredAt).toISOString().slice(0, 10) !== new Date(now).toISOString().slice(0, 10) ||
    measuredAt > now + 30_000 ||
    now - measuredAt > CODE_USAGE_MAX_AGE_MS
  ) {
    return "CODE is blocked because provider spending data is stale.";
  }
  if (
    !Number.isFinite(state.dailySpendLimitUsd) ||
    state.dailySpendLimitUsd <= 0 ||
    state.dailySpendLimitUsd > CODE_DAILY_SPEND_LIMIT_USD ||
    state.providerSpendTodayUsd >= state.dailySpendLimitUsd
  ) {
    return "CODE daily spending limit has been reached or is invalid.";
  }
  if (
    state.reservedHoldsUsd === null ||
    state.perTaskReserveUsd === null ||
    !Number.isFinite(state.reservedHoldsUsd) ||
    !Number.isFinite(state.perTaskReserveUsd) ||
    state.reservedHoldsUsd < 0 ||
    state.perTaskReserveUsd <= 0 ||
    state.perTaskReserveUsd > CODE_DAILY_SPEND_LIMIT_USD
  ) {
    return "CODE is blocked because spend reservation data is unavailable.";
  }
  if (
    state.providerSpendTodayUsd + state.reservedHoldsUsd + state.perTaskReserveUsd >
    state.dailySpendLimitUsd
  ) {
    return "CODE is blocked because the task's worst-case spend reservation exceeds the remaining daily limit.";
  }
  return totalSpendBlockReason(state.totalSpendGuard, state.perTaskReserveUsd);
}

/** Parses code_total_spend_guard_status(); anything unexpected becomes null (fail closed). */
export function parseTotalSpendGuard(value: unknown): CodeSafetyState["totalSpendGuard"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const limitUsd = Number(row["limit_usd"]);
  const committedUsd = Number(row["committed_usd"]);
  if (row["limit_usd"] == null || row["committed_usd"] == null) return null;
  if (!Number.isFinite(limitUsd) || !Number.isFinite(committedUsd)) return null;
  return { enforced: row["enforced"] === true, limitUsd, committedUsd };
}

/** Mirrors the database's cumulative guard: committed + this task's reservation must fit the total. */
export function totalSpendBlockReason(
  guard: CodeSafetyState["totalSpendGuard"],
  perTaskReserveUsd: number,
): string | null {
  if (
    !guard ||
    guard.enforced !== true ||
    !Number.isFinite(guard.limitUsd) ||
    !Number.isFinite(guard.committedUsd) ||
    guard.limitUsd <= 0 ||
    guard.limitUsd > CODE_TOTAL_SPEND_LIMIT_USD ||
    guard.committedUsd < 0
  ) {
    return "CODE is blocked because the cumulative $10 spending guard is not installed or not enforced.";
  }
  // Compare in cents so 9 + 1 = 10.00 fits exactly.
  if (Math.round((guard.committedUsd + perTaskReserveUsd) * 100) > Math.round(guard.limitUsd * 100)) {
    return "CODE is blocked because the cumulative spending total would exceed its limit.";
  }
  return null;
}

/** Environment policy may narrow stored approval, never add permission or a new workflow. */
export function restrictCodeTargets(stored: Record<string, CodeTarget>, configured: string | undefined): Record<string, CodeTarget> {
  if (!configured) return {};
  const policy = parseCodeTargets(JSON.parse(configured));
  const entries = Object.entries(policy);
  if (entries.length !== 1 || entries[0]?.[0] !== "OMERTA-ROW/jackboy-dev-control" || entries[0]?.[1].ref !== "main") {
    throw new Error("CODE_TARGETS must allow only OMERTA-ROW/jackboy-dev-control on main.");
  }
  return Object.fromEntries(entries.filter(([repo, target]) => stored[repo]?.ref === target.ref && stored[repo]?.workflowSha === target.workflowSha));
}

export function nextConsecutiveFailures(current: number, outcome: "success" | "failure") {
  if (!Number.isInteger(current) || current < 0) throw new Error("Invalid CODE failure counter.");
  return outcome === "success" ? 0 : current + 1;
}

export function shouldPauseForSpend(
  spendUsd: number,
  hourlyIncreaseUsd: number,
  dailyLimitUsd: number,
) {
  if (![spendUsd, hourlyIncreaseUsd, dailyLimitUsd].every(Number.isFinite)) {
    throw new Error("Provider spending metrics are unavailable.");
  }
  return spendUsd >= dailyLimitUsd || hourlyIncreaseUsd >= dailyLimitUsd * 0.5;
}

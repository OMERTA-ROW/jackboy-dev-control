export const CODE_DAILY_SPEND_LIMIT_USD = 5;
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
  return null;
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

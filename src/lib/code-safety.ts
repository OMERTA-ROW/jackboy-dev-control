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
  /** Live gateway-ledger meter (code_spend_meter_status); null when not installed or unreadable. */
  spendMeter: SpendMeter | null;
};

/** Fresh admission meter: the gateway's own ledger is the real-time measurement; OpenAI's delayed
 * reports are the later cross-check. Mirrors code_spend_meter_status(). */
export type SpendMeter = {
  ok: boolean;
  reasons: string[];
  measuredAt: string;
  measuredTodayUsd: number;
  gatewayTodayUsd: number;
  providerTodayUsd: number;
  gatewayHourUsd: number;
  unreportedDays: string[];
  bypassDays: string[];
};

const METER_REASONS: Record<string, string> = {
  controls_missing: "CODE safety controls are missing.",
  total_guard: "the $10 total spending guard is not enforced",
  daily_limit: "today's measured spending plus one task would pass the daily limit",
  hourly_spike: "gateway spending in the last hour reached half the daily limit",
  usage_spike: "a usage spike is recorded",
  recent_overrun: "a provider call cost more than its admitted ceiling in the last 24 hours",
  unreported_days: "a past day with CODE calls has no OpenAI closed-day report yet",
  bypass_suspected: "OpenAI reported more spending than the gateway admitted on a past day",
};
export function meterReasonText(reason: string): string {
  return METER_REASONS[reason] ?? `unrecognised meter check (${reason})`;
}

/** Parses code_spend_meter_status(); anything unexpected becomes null (fail closed). */
export function parseSpendMeter(value: unknown): SpendMeter | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const num = (key: string) => (row[key] == null ? NaN : Number(row[key]));
  const strings = (key: string) =>
    Array.isArray(row[key]) && (row[key] as unknown[]).every((v) => typeof v === "string") ? (row[key] as string[]) : null;
  const reasons = strings("reasons");
  const unreportedDays = strings("unreported_days") ?? [];
  const bypassDays = strings("bypass_days") ?? [];
  const measuredAt = typeof row["measured_at"] === "string" ? row["measured_at"] : null;
  const values = ["measured_today_usd", "gateway_today_usd", "provider_today_usd", "gateway_hour_usd"].map(num);
  if (typeof row["ok"] !== "boolean" || !reasons || !measuredAt || values.some((v) => !Number.isFinite(v) || v < 0)) return null;
  const [measuredTodayUsd, gatewayTodayUsd, providerTodayUsd, gatewayHourUsd] = values as [number, number, number, number];
  // "ok" must agree with an empty reason list, and the measurement must be the larger source.
  const ok = row["ok"] === true && reasons.length === 0 && measuredTodayUsd + 1e-9 >= Math.max(gatewayTodayUsd, providerTodayUsd);
  return { ok, reasons: ok ? [] : reasons.length ? reasons : ["unrecognised"], measuredAt, measuredTodayUsd, gatewayTodayUsd, providerTodayUsd, gatewayHourUsd, unreportedDays, bypassDays };
}

/** The OpenAI cross-check works through the oldest past day the meter is waiting on; otherwise yesterday (UTC). */
export function closedDayToReconcile(unreportedDays: string[], now: Date): string {
  const valid = unreportedDays.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (valid[0]) return valid[0];
  return new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
}

/** Passkey target for the owner switch that releases the CODE stop and turns CODE on. */
export const CODE_ENABLE_TARGET = "code_runtime:enable";

export type CodeEnableInput = {
  enabled: boolean;
  killSwitch: boolean;
  activeRequestId: string | null;
  activeRunId: number | string | null;
  consecutiveFailures: number;
  usageSpike: boolean;
  cancellationStatus: string;
  providerBudgetEnforced: boolean;
  totalSpendGuard: CodeSafetyState["totalSpendGuard"];
  perTaskReserveUsd: number | null;
  spendMeter: SpendMeter | null;
  /** automation_policy.paused; null when unreadable. */
  globalPaused: boolean | null;
  /** Database pin, CODE_TARGETS and live GitHub workflow all match; null when unverified. */
  pinsMatch: boolean | null;
  /** Provider key present, CODE_GATEWAY_PRICES parses, per-call cap valid (names/format only). */
  gatewayConfigured: boolean;
  /** OPENAI_ADMIN_KEY, OPENAI_CODE_PROJECT_ID, OPENAI_CODE_API_KEY_ID present (names only). */
  costCheckConfigured: boolean;
};
export type CodeEnableGate = { id: string; label: string; ok: boolean; detail: string };

/** Every gate the owner switch checks, in order. All must pass; the database re-checks its share. */
export function codeEnableGates(i: CodeEnableInput): CodeEnableGate[] {
  const guard = i.totalSpendGuard;
  const reserve = i.perTaskReserveUsd;
  const guardOk =
    !!guard && guard.enforced === true && guard.limitUsd > 0 && guard.limitUsd <= CODE_TOTAL_SPEND_LIMIT_USD &&
    guard.committedUsd >= 0 && reserve !== null && Number.isFinite(reserve) && reserve > 0 &&
    Math.round((guard.committedUsd + reserve) * 100) <= Math.round(guard.limitUsd * 100);
  const meter = i.spendMeter;
  return [
    { id: "stopped", label: "CODE is off and the Emergency Stop is on", ok: !i.enabled && i.killSwitch, detail: i.enabled || !i.killSwitch ? "CODE is already on or the stop is released." : "Ready to switch." },
    { id: "no_task", label: "No CODE task is running", ok: !i.activeRequestId && !i.activeRunId, detail: i.activeRequestId ? "A task is still recorded as active." : "None active." },
    { id: "failures", label: "Two-failure stop is clear", ok: Number.isInteger(i.consecutiveFailures) && i.consecutiveFailures >= 0 && i.consecutiveFailures < CODE_MAX_CONSECUTIVE_FAILURES, detail: `${i.consecutiveFailures}/${CODE_MAX_CONSECUTIVE_FAILURES} consecutive failures.` },
    { id: "spike", label: "No usage spike recorded", ok: !i.usageSpike, detail: i.usageSpike ? "A spike pause is recorded." : "None recorded." },
    { id: "cancellation", label: "Any stopped run is confirmed finished", ok: ["not_needed", "confirmed", "completed"].includes(i.cancellationStatus), detail: `Status: ${i.cancellationStatus}.` },
    { id: "hard_cap", label: "Provider hard cap marked verified by you", ok: i.providerBudgetEnforced === true, detail: i.providerBudgetEnforced ? "Marked verified." : "Mark it first (needs a passkey)." },
    { id: "total_guard", label: "$10 total spending guard active with room for one task", ok: guardOk, detail: !guard ? "Guard not installed or unreadable." : `$${guard.committedUsd.toFixed(2)} of $${guard.limitUsd.toFixed(2)} used.` },
    { id: "meter", label: "Live spending meter healthy", ok: meter?.ok === true, detail: !meter ? "Meter not installed or unreadable." : meter.ok ? `$${meter.measuredTodayUsd.toFixed(2)} measured today.` : meter.reasons.map(meterReasonText).join("; ") + "." },
    { id: "global_pause", label: "Global pause is off", ok: i.globalPaused === false, detail: i.globalPaused === null ? "Global pause state unreadable." : i.globalPaused ? "Turn the global pause off first (needs a passkey)." : "Off." },
    { id: "pins", label: "Workflow pins match (database, CODE_TARGETS, GitHub main)", ok: i.pinsMatch === true, detail: i.pinsMatch === null ? "Could not verify against GitHub." : i.pinsMatch ? "All three match." : "Pins differ; resync first." },
    { id: "gateway", label: "Gateway settings present", ok: i.gatewayConfigured, detail: i.gatewayConfigured ? "Provider key, prices and per-call cap are set." : "Provider key, price table or per-call cap missing or invalid." },
    { id: "cost_check", label: "OpenAI cost cross-check settings present", ok: i.costCheckConfigured, detail: i.costCheckConfigured ? "Admin key, project and key IDs are set." : "OpenAI cost-report settings missing." },
  ];
}

export function codeEnableBlockReason(i: CodeEnableInput): string | null {
  const failed = codeEnableGates(i).find((gate) => !gate.ok);
  return failed ? `${failed.label}: ${failed.detail}` : null;
}

const ENABLE_DB_REASONS: Record<string, string> = {
  not_stopped: "CODE is already on or the Emergency Stop is released",
  active_task: "a CODE task is still active",
  failure_stop: "the two-failure stop is engaged",
  usage_spike: "a usage spike is recorded",
  cancellation_unconfirmed: "a stopped run is not confirmed finished",
  hard_cap_unverified: "the provider hard cap is not marked verified",
  total_guard: "the $10 total spending guard is not enforced",
  total_limit: "the $10 total has no room for another task",
  spend_meter: "the live spending meter is not healthy",
  global_pause: "the global pause is on",
  target_allowlist: "the repository allowlist is not exactly Jackboy on main",
};
export function enableRefusalText(reasons: unknown): string {
  const list = Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === "string") : [];
  return list.length ? list.map((r) => ENABLE_DB_REASONS[r] ?? r).join("; ") : "the database refused without a reason";
}

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
  if (!state.spendMeter || state.spendMeter.ok !== true) {
    return "CODE is blocked because the live spending meter is not installed or not healthy.";
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

/** Passkey targets bind each grant to one direction, so a "mark" grant can never un-mark (or vice versa). */
export const HARD_CAP_TARGET = { mark: "code_hard_cap:verify", unmark: "code_hard_cap:unverify" } as const;
export const HARD_CAP_EVIDENCE_MIN = 10;
export const HARD_CAP_EVIDENCE_MAX = 500;

export type HardCapChangeInput = {
  verified: boolean;
  evidence: string;
  current: {
    enabled: boolean;
    killSwitch: boolean;
    activeRequestId: string | null;
    activeRunId: number | string | null;
    providerBudgetEnforced: boolean;
    totalSpendGuard: CodeSafetyState["totalSpendGuard"];
  };
};

/** Owner hard-cap attestation: only while CODE is off, Emergency Stop on and no task is active.
 * Marking also needs the cumulative $10 guard enforced and within its limit. The database re-checks all of it. */
export function hardCapChangeBlockReason({ verified, evidence, current }: HardCapChangeInput): string | null {
  const note = evidence.trim();
  if (note.length < HARD_CAP_EVIDENCE_MIN || note.length > HARD_CAP_EVIDENCE_MAX)
    return `Write a short evidence note (${HARD_CAP_EVIDENCE_MIN}–${HARD_CAP_EVIDENCE_MAX} characters).`;
  if (current.enabled) return "Turn CODE off first.";
  if (!current.killSwitch) return "Turn the Emergency Stop on first.";
  if (current.activeRequestId || current.activeRunId) return "Wait until no CODE task is active.";
  if (current.providerBudgetEnforced === verified)
    return verified ? "The hard cap is already marked verified." : "The hard cap is already unverified.";
  if (verified) {
    const guard = current.totalSpendGuard;
    if (!guard || guard.enforced !== true) return "The $10 total spending guard must be active first.";
    if (!(guard.limitUsd > 0) || guard.limitUsd > CODE_TOTAL_SPEND_LIMIT_USD) return "The total spending limit is invalid.";
    if (guard.committedUsd >= guard.limitUsd) return "The $10 total spending limit is already used up.";
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

/** Owner-facing reason a repository has no usable CODE target. Wording only: the caller still refuses. */
export function codeTargetRefusal(repo: string, allowed: Record<string, CodeTarget>): string | null {
  const target = Object.hasOwn(allowed, repo) ? allowed[repo] : undefined;
  if (target && /^[\w./-]{1,100}$/.test(target.ref) && /^[a-f0-9]{40}$/.test(target.workflowSha)) return null;
  const names = Object.keys(allowed);
  if (!names.length)
    return `CODE refused ${repo}: no repository is currently allowed. The saved CODE_TARGETS setting is missing here or doesn't match the database pin, so nothing can run until the owner fixes that match.`;
  if (!target)
    return `CODE refused ${repo}: it isn't on the CODE allow list. Only ${names.join(", ")} is allowed. Adding another repository needs a separate owner approval.`;
  return `CODE refused ${repo}: its approved branch or workflow version is invalid. The owner must re-approve the pin.`;
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

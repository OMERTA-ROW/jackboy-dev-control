import { supabaseAdmin as typedDb } from "@/integrations/supabase/client.server";
import { untyped } from "./untyped-db";
const db = untyped(typedDb);
import {
  codeStartBlockReason,
  parseTotalSpendGuard,
  parseCodeTargets,
  restrictCodeTargets,
  shouldPauseForSpend,
  type CodeSafetyState,
} from "./code-safety";

export async function getCodeSafetyState(now = Date.now()): Promise<CodeSafetyState> {
  const { data, error } = await db
    .from("code_runtime_controls")
    .select(
      "enabled, kill_switch, allowed_targets, active_request_id, consecutive_failures, daily_spend_limit_usd, provider_hard_cap_verified, provider_usage_at, usage_spike, paused_reason, per_task_reserve_usd",
    )
    .eq("singleton", true)
    .single();
  if (error || !data) throw new Error("CODE runtime safety controls are unavailable.");

  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const [today, hour] = await Promise.all([
    db.from("code_usage_events").select("cost_usd").gte("occurred_at", startOfDay.toISOString()),
    db
      .from("code_usage_events")
      .select("cost_usd")
      .gte("occurred_at", new Date(now - 3_600_000).toISOString()),
  ]);
  if (today.error || hour.error) throw new Error("CODE provider spending data could not be read.");
  const holds = await db
    .from("code_spend_reservations")
    .select("reserved_usd")
    .neq("status", "settled");
  const reservedHoldsUsd = holds.error
    ? null
    : (holds.data ?? []).reduce(
        (total: number, row: { reserved_usd: number }) => total + Number(row.reserved_usd),
        0,
      );
  const perTaskReserveUsd = Number(data.per_task_reserve_usd);
  // Absent until the reviewed cumulative-guard migration is applied; any error fails closed.
  const guardResult = await db.rpc("code_total_spend_guard_status");
  const totalSpendGuard = parseTotalSpendGuard(guardResult.error ? null : guardResult.data);
  const sum = (rows: { cost_usd: number }[] | null) =>
    (rows ?? []).reduce((total, row) => total + Number(row.cost_usd), 0);
  const providerSpendTodayUsd = sum(today.data);
  const hourlySpend = sum(hour.data);
  const dailySpendLimitUsd = Number(data.daily_spend_limit_usd);
  const providerUsageAt = data.provider_usage_at;
  const spendPause =
    Number.isFinite(dailySpendLimitUsd) &&
    shouldPauseForSpend(providerSpendTodayUsd, hourlySpend, dailySpendLimitUsd);
  const usageSpike = data.usage_spike || (spendPause && hourlySpend >= dailySpendLimitUsd * 0.5);
  const capReached = spendPause && providerSpendTodayUsd >= dailySpendLimitUsd;
  if ((usageSpike || capReached) && (!data.kill_switch || data.enabled || !data.paused_reason)) {
    const pausedReason = usageSpike
      ? "Paused: provider usage spike reached the alert threshold."
      : "Paused: authoritative daily provider spending reached the cap.";
    const { error: pauseError } = await db
      .from("code_runtime_controls")
      .update({
        enabled: false,
        kill_switch: true,
        usage_spike: usageSpike,
        paused_reason: pausedReason,
        updated_at: new Date(now).toISOString(),
      })
      .eq("singleton", true);
    if (pauseError)
      throw new Error(
        "CODE spending threshold was reached but the emergency pause could not be persisted.",
      );
    const { error: auditError } = await db.from("audit_logs").insert({
      actor: null,
      action: usageSpike ? "code.usage_spike_pause" : "code.daily_spend_cap_pause",
      detail: {
        daily_spend_limit_usd: dailySpendLimitUsd,
        spend_today_usd: providerSpendTodayUsd,
        spend_last_hour_usd: hourlySpend,
      },
      outcome: "paused",
    });
    if (auditError)
      throw new Error("CODE spending pause is active but its audit alert could not be recorded.");
  }

  return {
    enabled: spendPause ? false : data.enabled,
    killSwitch: spendPause ? true : data.kill_switch,
    allowedTargets: restrictCodeTargets(parseCodeTargets(data.allowed_targets), process.env["CODE_TARGETS"]),
    activeRequestId: data.active_request_id,
    consecutiveFailures: data.consecutive_failures,
    dailySpendLimitUsd,
    providerSpendTodayUsd,
    providerUsageAt,
    providerBudgetEnforced: data.provider_hard_cap_verified,
    reservedHoldsUsd,
    perTaskReserveUsd: Number.isFinite(perTaskReserveUsd) ? perTaskReserveUsd : null,
    usageSpike,
    totalSpendGuard,
  };
}

export async function codeSafetyBlockReason(repo: string, now = Date.now()) {
  const state = await getCodeSafetyState(now);
  return codeStartBlockReason(state, repo, now);
}

import { describe, expect, it } from "vitest";
import {
  CODE_DISABLE_TARGET,
  CODE_ENABLE_TARGET,
  CODE_STOP_RELEASE_TARGET,
  HARD_CAP_TARGET,
  closedDayToReconcile,
  codeEnableBlockReason,
  codeEnableGates,
  enableRefusalText,
  parseSpendMeter,
  stopReleaseBlockReason,
  stopReleaseGates,
  type CodeEnableInput,
  type SpendMeter,
} from "./code-safety";
import { FRESH_ONLY_ACTIONS, mayRequest, recentEligible } from "./step-up";

const healthyMeter: SpendMeter = {
  ok: true,
  reasons: [],
  measuredAt: "2026-11-07T00:40:00Z",
  measuredTodayUsd: 0,
  gatewayTodayUsd: 0,
  providerTodayUsd: 0,
  gatewayHourUsd: 0,
  unreportedDays: [],
  bypassDays: [],
};
const ready: CodeEnableInput = {
  enabled: false,
  killSwitch: true,
  activeRequestId: null,
  activeRunId: null,
  consecutiveFailures: 0,
  usageSpike: false,
  cancellationStatus: "not_needed",
  providerBudgetEnforced: true,
  totalSpendGuard: { enforced: true, limitUsd: 10, committedUsd: 0 },
  perTaskReserveUsd: 1,
  spendMeter: healthyMeter,
  globalPaused: false,
  pinsMatch: true,
  gatewayConfigured: true,
  costCheckConfigured: true,
};
const failing = (patch: Partial<CodeEnableInput>) =>
  codeEnableGates({ ...ready, ...patch }).filter((g) => !g.ok).map((g) => g.id);

describe("owner CODE on-switch gates", () => {
  it("passes only when every gate passes", () => {
    expect(codeEnableBlockReason(ready)).toBeNull();
    expect(codeEnableGates(ready).every((g) => g.ok)).toBe(true);
  });

  it("treats the Kill Switch and the Emergency Stop as separate controls, not requirements", () => {
    // Turning the saved CODE setting on never needs (or changes) the other two controls.
    for (const killSwitch of [true, false]) for (const globalPaused of [true, false, null]) {
      expect(failing({ killSwitch, globalPaused })).toEqual([]);
    }
    expect(codeEnableGates(ready).map((g) => g.id)).not.toContain("stopped");
    expect(codeEnableGates(ready).map((g) => g.id)).not.toContain("global_pause");
  });

  it("refuses while anything is running or a stopped run is unconfirmed", () => {
    expect(failing({ activeRequestId: "r1" })).toEqual(["no_task"]);
    expect(failing({ activeRunId: 42 })).toEqual(["no_task"]);
    expect(failing({ cancellationStatus: "pending" })).toEqual(["cancellation"]);
    expect(failing({ cancellationStatus: "unverified" })).toEqual(["cancellation"]);
    expect(failing({ cancellationStatus: "confirmed" })).toEqual([]);
  });

  it("refuses at the two-failure stop and on a usage spike", () => {
    expect(failing({ consecutiveFailures: 1 })).toEqual([]);
    expect(failing({ consecutiveFailures: 2 })).toEqual(["failures"]);
    expect(failing({ consecutiveFailures: Number.NaN })).toEqual(["failures"]);
    expect(failing({ usageSpike: true })).toEqual(["spike"]);
  });

  it("needs the owner-marked hard cap and room for one task inside the $10 total", () => {
    expect(failing({ providerBudgetEnforced: false })).toEqual(["hard_cap"]);
    expect(failing({ totalSpendGuard: null })).toEqual(["total_guard"]);
    expect(failing({ totalSpendGuard: { enforced: false, limitUsd: 10, committedUsd: 0 } })).toEqual(["total_guard"]);
    expect(failing({ totalSpendGuard: { enforced: true, limitUsd: 10, committedUsd: 9 } })).toEqual([]); // 9 + 1 = 10.00
    expect(failing({ totalSpendGuard: { enforced: true, limitUsd: 10, committedUsd: 9.01 } })).toEqual(["total_guard"]);
    expect(failing({ totalSpendGuard: { enforced: true, limitUsd: 10.5, committedUsd: 0 } })).toEqual(["total_guard"]);
    expect(failing({ perTaskReserveUsd: null })).toEqual(["total_guard"]);
  });

  it("needs a healthy live meter, matching pins and the settings present", () => {
    expect(failing({ spendMeter: null })).toEqual(["meter"]);
    expect(failing({ spendMeter: { ...healthyMeter, ok: false, reasons: ["daily_limit"] } })).toEqual(["meter"]);
    expect(failing({ pinsMatch: false })).toEqual(["pins"]);
    expect(failing({ pinsMatch: null })).toEqual(["pins"]);
    expect(failing({ gatewayConfigured: false })).toEqual(["gateway"]);
    expect(failing({ costCheckConfigured: false })).toEqual(["cost_check"]);
  });

  it("explains database refusals in plain words, and never reports an empty refusal as success", () => {
    expect(enableRefusalText(["global_pause", "spend_meter"])).toBe("the Kill Switch is on; the live spending meter is not healthy");
    expect(enableRefusalText([])).toMatch(/refused/);
    expect(enableRefusalText(null)).toMatch(/refused/);
  });
});

describe("Emergency Stop release requirements", () => {
  const releaseFailing = (patch: Partial<CodeEnableInput>) =>
    stopReleaseGates({ ...ready, ...patch }).filter((g) => !g.ok).map((g) => g.id);
  it("does not depend on the CODE setting or the Kill Switch", () => {
    for (const enabled of [true, false]) for (const globalPaused of [true, false, null]) {
      expect(releaseFailing({ enabled, globalPaused })).toEqual([]);
    }
  });
  it("never bypasses an emergency protection, the hard cap or the $10 guard", () => {
    expect(releaseFailing({ activeRequestId: "r1" })).toEqual(["no_task"]);
    expect(releaseFailing({ cancellationStatus: "pending" })).toEqual(["cancellation"]);
    expect(releaseFailing({ consecutiveFailures: 2 })).toEqual(["failures"]);
    expect(releaseFailing({ usageSpike: true })).toEqual(["spike"]);
    expect(releaseFailing({ providerBudgetEnforced: false })).toEqual(["hard_cap"]);
    expect(releaseFailing({ totalSpendGuard: null })).toEqual(["total_guard"]);
    expect(releaseFailing({ totalSpendGuard: { enforced: false, limitUsd: 10, committedUsd: 0 } })).toEqual(["total_guard"]);
    expect(stopReleaseBlockReason({ ...ready, usageSpike: true })).toMatch(/usage spike/);
    expect(stopReleaseBlockReason(ready)).toBeNull();
  });
});

describe("live spending meter parsing (fail closed)", () => {
  const raw = {
    ok: true,
    reasons: [],
    measured_at: "2026-11-07T00:40:00Z",
    measured_today_usd: 1.2,
    gateway_today_usd: 1.2,
    provider_today_usd: 0.4,
    gateway_hour_usd: 0.3,
    unreported_days: [],
    bypass_days: [],
  };
  it("accepts a well-formed healthy status", () => {
    expect(parseSpendMeter(raw)?.ok).toBe(true);
    expect(parseSpendMeter(raw)?.measuredTodayUsd).toBe(1.2);
  });
  it("treats anything missing, malformed or self-contradictory as unavailable or unhealthy", () => {
    expect(parseSpendMeter(null)).toBeNull();
    expect(parseSpendMeter([])).toBeNull();
    expect(parseSpendMeter({ ...raw, ok: "true" })).toBeNull();
    expect(parseSpendMeter({ ...raw, measured_today_usd: null })).toBeNull();
    expect(parseSpendMeter({ ...raw, gateway_today_usd: -1 })).toBeNull();
    expect(parseSpendMeter({ ...raw, reasons: "none" })).toBeNull();
    expect(parseSpendMeter({ ...raw, ok: true, reasons: ["daily_limit"] })?.ok).toBe(false);
    // The measurement must be the larger of the gateway ledger and the OpenAI report.
    expect(parseSpendMeter({ ...raw, measured_today_usd: 0.4 })?.ok).toBe(false);
    expect(parseSpendMeter({ ...raw, ok: false, reasons: [] })?.reasons).toEqual(["unrecognised"]);
  });
});

describe("OpenAI cross-check day", () => {
  it("works through the oldest waiting day first, otherwise yesterday (UTC)", () => {
    const now = new Date("2026-11-07T00:40:00Z");
    expect(closedDayToReconcile(["2026-11-04", "2026-11-03"], now)).toBe("2026-11-03");
    expect(closedDayToReconcile([], now)).toBe("2026-11-06");
    expect(closedDayToReconcile(["bad"], now)).toBe("2026-11-06");
  });
});

describe("on-switch passkey", () => {
  it("is owner-only, always needs a new passkey check and has its own target", () => {
    expect(mayRequest("code_enable", "owner")).toEqual({ ok: true });
    expect(mayRequest("code_enable", "admin").ok).toBe(false);
    expect(FRESH_ONLY_ACTIONS).toContain("code_enable");
    expect(recentEligible("code_enable", CODE_ENABLE_TARGET)).toBe(false);
    expect(CODE_ENABLE_TARGET).not.toBe(HARD_CAP_TARGET.mark);
  });
  it("binds on, off and stop release to different targets; release has its own fresh-only action", () => {
    expect(new Set([CODE_ENABLE_TARGET, CODE_DISABLE_TARGET, CODE_STOP_RELEASE_TARGET]).size).toBe(3);
    expect(mayRequest("code_stop_release", "owner")).toEqual({ ok: true });
    expect(mayRequest("code_stop_release", "admin").ok).toBe(false);
    expect(FRESH_ONLY_ACTIONS).toContain("code_stop_release");
    expect(recentEligible("code_stop_release", CODE_STOP_RELEASE_TARGET)).toBe(false);
  });
});

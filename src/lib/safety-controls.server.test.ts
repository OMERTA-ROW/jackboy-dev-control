import { beforeEach, describe, expect, it, vi } from "vitest";

// Server-side behaviour of the three controls, with the database replaced by a recorder.
const f = vi.hoisted(() => ({ consume: vi.fn(), adminCalls: [] as string[], userCalls: [] as string[], codeStopError: null as unknown, installed: false }));
vi.mock("@tanstack/react-start", () => ({ createServerFn: () => { const chain = { middleware: () => chain, inputValidator: () => chain, handler: (fn: unknown) => fn }; return chain; } }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./passkey.server", () => ({ consumeGrant: f.consume }));
vi.mock("./untyped-db", () => ({ untyped: (db: unknown) => db }));

function table(name: string, calls: string[], row: Record<string, unknown>) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) q[m] = () => q;
  q["update"] = () => { calls.push(`update:${name}`); return q; };
  q["single"] = async () => ({ data: row, error: null });
  q["maybeSingle"] = async () => ({ data: row, error: null });
  (q as { then: unknown }).then = (res: (v: unknown) => unknown) => res({ data: null, error: null });
  return q;
}
const START: Record<string, Record<string, unknown>> = {
  automation_policy: { paused: true, tier: 1, max_files: 3, max_lines: 50, updated_at: "2026-11-13T00:00:00Z" },
  code_runtime_controls: { enabled: false, kill_switch: true, active_request_id: null, active_run_id: null, cancellation_status: "not_needed", paused_reason: "x", stop_requested_at: null, updated_at: null, consecutive_failures: 0, usage_spike: false, provider_hard_cap_verified: true, per_task_reserve_usd: 1, allowed_targets: {} },
  foundry_schedule: {},
};
const ROWS: Record<string, Record<string, unknown>> = {};
const GUARD = { enforced: true, limit_usd: 10, committed_usd: 0 };
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (name: string) => table(name, f.adminCalls, ROWS[name] ?? {}),
    rpc: async (name: string, args?: Record<string, unknown>) => {
      f.adminCalls.push(`rpc:${name}${args && "p_enabled" in args ? `:${String(args["p_enabled"])}` : ""}`);
      const c = ROWS["code_runtime_controls"]!;
      if (name === "engage_code_kill_switch") return { data: [{}], error: f.codeStopError };
      if (name === "code_independent_controls_installed") return { data: f.installed, error: null };
      if (name === "code_total_spend_guard_status") return { data: GUARD, error: null };
      if (name === "set_code_enabled") { c["enabled"] = args?.["p_enabled"]; return { data: { ok: true }, error: null }; }
      if (name === "release_code_emergency_stop") { c["kill_switch"] = false; return { data: { ok: true }, error: null }; }
      return { data: null, error: null };
    },
  },
}));

import { getSafetyControlState, releaseCodeEmergencyStop, resumeJackboyWork, setCodeEnabled, stopJackboyWork } from "./code-safety.functions";
import { CODE_DISABLE_TARGET, CODE_STOP_RELEASE_TARGET } from "./code-safety";

type Fn = (arg: { data?: unknown; context: unknown }) => Promise<Record<string, unknown>>;
const GRANT = { grantId: "11111111-1111-4111-8111-111111111111" };
const ctx = (role = "owner") => ({
  userId: "owner-id",
  supabase: {
    rpc: async (name: string, args?: unknown) => { f.userCalls.push(`rpc:${name}:${JSON.stringify(args ?? null)}`); return { data: name === "my_role" ? role : null, error: null }; },
    from: (name: string) => table(name, f.userCalls, ROWS[name] ?? {}),
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  f.adminCalls.length = 0;
  f.userCalls.length = 0;
  f.codeStopError = null;
  f.installed = false;
  for (const [k, v] of Object.entries(START)) ROWS[k] = { ...v };
  f.consume.mockResolvedValue(undefined);
});
const writes = () => f.adminCalls.filter((c) => !/rpc:(code_independent_controls_installed|code_total_spend_guard_status|code_spend_meter_status)/.test(c));

describe("Kill Switch, CODE and Emergency Stop on the server", () => {
  it("turning the Kill Switch off never touches CODE or its Emergency Stop", async () => {
    const result = await (resumeJackboyWork as unknown as Fn)({ data: GRANT, context: ctx() });
    expect(result).toEqual({ paused: false });
    expect(f.consume).toHaveBeenCalledWith(GRANT.grantId, "owner-id", "global_pause", "global_pause:off");
    expect(f.userCalls.some((c) => c.startsWith("rpc:set_automation_policy:") && c.includes('"_paused":false'))).toBe(true);
    expect(f.adminCalls.filter((c) => c.includes("code_runtime") || c.includes("enable_code_runtime") || c.includes("engage_code_kill_switch"))).toEqual([]);
  });

  it("until the database enforces the Kill Switch for CODE, turning it on also engages the CODE stop (fail closed)", async () => {
    const result = await (stopJackboyWork as unknown as Fn)({ data: GRANT, context: ctx() });
    expect(f.adminCalls).toContain("rpc:engage_code_kill_switch");
    expect(result["codeStopSaved"]).toBe(true);
  });

  it("never claims CODE is blocked when the CODE Emergency Stop could not be saved", async () => {
    f.codeStopError = { message: "db down" };
    const result = await (stopJackboyWork as unknown as Fn)({ data: GRANT, context: ctx() });
    expect(result["codeStopSaved"]).toBe(false);
    expect(String(result["warning"])).toMatch(/could NOT be saved/);
    expect(String(result["warning"])).not.toMatch(/CODE stays blocked/);
  });

  it("a passkey failure changes nothing", async () => {
    f.consume.mockRejectedValue(new Error("Passkey required"));
    await expect((resumeJackboyWork as unknown as Fn)({ data: GRANT, context: ctx() })).rejects.toThrow("Passkey required");
    await expect((stopJackboyWork as unknown as Fn)({ data: GRANT, context: ctx() })).rejects.toThrow("Passkey required");
    expect(f.userCalls.filter((c) => c.startsWith("rpc:set_automation_policy"))).toEqual([]);
    expect(f.adminCalls).toEqual([]);
  });

  it("only the owner can read or change the controls", async () => {
    await expect((getSafetyControlState as unknown as Fn)({ context: ctx("member") })).rejects.toThrow(/Only the owner/);
    await expect((resumeJackboyWork as unknown as Fn)({ data: GRANT, context: ctx("member") })).rejects.toThrow(/Only the owner/);
    expect(f.consume).not.toHaveBeenCalled();
  });

  it("the live read reports all three states and whether they are independent, and writes nothing", async () => {
    const result = await (getSafetyControlState as unknown as Fn)({ context: ctx() });
    expect(result["globalPaused"]).toBe(true);
    expect(result["code"]).toMatchObject({ enabled: false, killSwitch: true });
    expect(result["independentControls"]).toBe(false);
    expect(writes()).toEqual([]);
  });

  it("once the database enforces the Kill Switch, turning it on leaves CODE and its stop alone and audits that", async () => {
    f.installed = true;
    const result = await (stopJackboyWork as unknown as Fn)({ data: GRANT, context: ctx() });
    expect(f.adminCalls).not.toContain("rpc:engage_code_kill_switch");
    expect(result["codeStopSaved"]).toBeNull();
    expect(result["codeControlsChanged"]).toBe(false);
    expect(String(result["warning"])).toMatch(/were not changed/);
    const audit = f.userCalls.find((c) => c.startsWith("rpc:write_audit:"));
    expect(audit).toContain('"code_controls":"unchanged"');
  });

  it("CODE on/off and stop release refuse with nothing changed until the database change is installed", async () => {
    await expect((setCodeEnabled as unknown as Fn)({ data: { ...GRANT, enabled: false }, context: ctx() })).rejects.toThrow(/not installed yet/);
    await expect((releaseCodeEmergencyStop as unknown as Fn)({ data: GRANT, context: ctx() })).rejects.toThrow(/not installed yet/);
    expect(f.consume).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it("turning CODE off changes only the CODE setting, with the off passkey", async () => {
    f.installed = true;
    ROWS["code_runtime_controls"]!["enabled"] = true;
    const result = await (setCodeEnabled as unknown as Fn)({ data: { ...GRANT, enabled: false }, context: ctx() });
    expect(f.consume).toHaveBeenCalledWith(GRANT.grantId, "owner-id", "code_enable", CODE_DISABLE_TARGET, { requireFresh: true });
    expect(writes()).toEqual(["rpc:set_code_enabled:false"]);
    expect(result).toMatchObject({ ok: true, codeEnabled: false, emergencyStop: true, killSwitch: true, othersUnchanged: true });
    expect(f.userCalls.filter((c) => c.startsWith("rpc:set_automation_policy"))).toEqual([]);
  });

  it("releasing the stop changes only the stop, with its own fresh passkey", async () => {
    f.installed = true;
    const result = await (releaseCodeEmergencyStop as unknown as Fn)({ data: GRANT, context: ctx() });
    expect(f.consume).toHaveBeenCalledWith(GRANT.grantId, "owner-id", "code_stop_release", CODE_STOP_RELEASE_TARGET, { requireFresh: true });
    expect(writes()).toEqual(["rpc:release_code_emergency_stop"]);
    expect(result).toMatchObject({ ok: true, emergencyStop: false, codeEnabled: false, killSwitch: true, othersUnchanged: true });
  });

  it("release is refused before the database is asked when an emergency protection holds", async () => {
    f.installed = true;
    ROWS["code_runtime_controls"]!["usage_spike"] = true;
    await expect((releaseCodeEmergencyStop as unknown as Fn)({ data: GRANT, context: ctx() })).rejects.toThrow(/usage spike/);
    expect(writes()).toEqual([]);
    expect(ROWS["code_runtime_controls"]!["kill_switch"]).toBe(true);
  });
});

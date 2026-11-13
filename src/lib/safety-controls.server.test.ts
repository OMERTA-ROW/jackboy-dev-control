import { beforeEach, describe, expect, it, vi } from "vitest";

// Server-side behaviour of the three controls, with the database replaced by a recorder.
const f = vi.hoisted(() => ({ consume: vi.fn(), adminCalls: [] as string[], userCalls: [] as string[], codeStopError: null as unknown }));
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
const ROWS: Record<string, Record<string, unknown>> = {
  automation_policy: { paused: true, tier: 1, max_files: 3, max_lines: 50, updated_at: "2026-11-13T00:00:00Z" },
  code_runtime_controls: { enabled: false, kill_switch: true, active_request_id: null, active_run_id: null, cancellation_status: "not_needed", paused_reason: "x", stop_requested_at: null, updated_at: null },
  foundry_schedule: {},
};
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (name: string) => table(name, f.adminCalls, ROWS[name] ?? {}),
    rpc: async (name: string) => { f.adminCalls.push(`rpc:${name}`); return name === "engage_code_kill_switch" ? { data: [{}], error: f.codeStopError } : { data: null, error: null }; },
  },
}));

import { getSafetyControlState, resumeJackboyWork, stopJackboyWork } from "./code-safety.functions";

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
  f.consume.mockResolvedValue(undefined);
});

describe("Kill Switch, CODE and Emergency Stop on the server", () => {
  it("turning the Kill Switch off never touches CODE or its Emergency Stop", async () => {
    const result = await (resumeJackboyWork as unknown as Fn)({ data: GRANT, context: ctx() });
    expect(result).toEqual({ paused: false });
    expect(f.consume).toHaveBeenCalledWith(GRANT.grantId, "owner-id", "global_pause", "global_pause:off");
    expect(f.userCalls.some((c) => c.startsWith("rpc:set_automation_policy:") && c.includes('"_paused":false'))).toBe(true);
    expect(f.adminCalls.filter((c) => c.includes("code_runtime") || c.includes("enable_code_runtime") || c.includes("engage_code_kill_switch"))).toEqual([]);
  });

  it("turning the Kill Switch on engages the CODE Emergency Stop (existing enforcement kept)", async () => {
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

  it("the live read reports all three states and writes nothing", async () => {
    const result = await (getSafetyControlState as unknown as Fn)({ context: ctx() });
    expect(result["globalPaused"]).toBe(true);
    expect(result["code"]).toMatchObject({ enabled: false, killSwitch: true });
    expect(f.adminCalls).toEqual([]);
  });
});

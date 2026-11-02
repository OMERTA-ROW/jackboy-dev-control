import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ approve: vi.fn(), verify: vi.fn(), consume: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({ createServerFn: () => { const chain = { middleware: () => chain, inputValidator: () => chain, handler: (fn: unknown) => fn }; return chain; } }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("./autoconnect.server", () => ({ approveCapability: f.approve, verifyCapability: f.verify }));
vi.mock("./passkey.server", () => ({ consumeGrant: f.consume }));
import { autoConnectAct } from "./autoconnect.functions";
const run = autoConnectAct as unknown as (arg: { data: { cap: string; projectId: string; op: string; grantId?: string }; context: { userId: string; supabase: { rpc: () => Promise<{ data: string }> } } }) => Promise<unknown>;
const ctx = { userId: "owner", supabase: { rpc: async () => ({ data: "owner" }) } };
beforeEach(() => {
  vi.clearAllMocks(); f.approve.mockResolvedValue({ status: "awaiting_setup" }); f.verify.mockResolvedValue({ status: "connected", resumed: 1 });
  f.consume.mockImplementation(async (grant: unknown) => { if (!grant) throw new Error("Passkey required"); });
});
describe("AutoConnect approval uses the same critical boundary as Blocker Queue", () => {
  it("does not provide an alternate approval path without a passkey", async () => {
    await expect(run({ data: { cap: "github_repo", projectId: "project", op: "approve" }, context: ctx })).rejects.toThrow("Passkey required");
    expect(f.approve).not.toHaveBeenCalled(); expect(f.verify).not.toHaveBeenCalled();
  });
  it("consumes the exact project/capability grant before approval and real verification", async () => {
    const result = await run({ data: { cap: "github_repo", projectId: "project", op: "approve", grantId: "grant" }, context: ctx });
    expect(f.consume).toHaveBeenCalledWith("grant", "owner", "approve_integration", "github_repo:project");
    expect(f.approve).toHaveBeenCalledWith("github_repo", "project", "owner:owner", "owner");
    expect(f.verify).toHaveBeenCalledWith("github_repo", "project", "owner:owner");
    expect(result).toEqual({ status: "connected", resumed: 1 });
  });
  it("denies an invited non-owner before any credential approval", async () => {
    await expect(run({ data: { cap: "github_repo", projectId: "project", op: "approve", grantId: "grant" }, context: { ...ctx, supabase: { rpc: async () => ({ data: "member" }) } } })).rejects.toThrow("Owner only");
    expect(f.consume).not.toHaveBeenCalled(); expect(f.approve).not.toHaveBeenCalled();
  });
});

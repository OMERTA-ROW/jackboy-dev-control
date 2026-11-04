import { beforeEach, describe, expect, it, vi } from "vitest";

const sb = vi.hoisted(() => ({
  user: { id: "u1" } as { id: string } | null,
  role: "owner" as string | null,
  getUserThrows: false,
  rpcThrows: false,
  getUserCalls: 0,
  rpcCalls: 0,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: {
      getUser: async () => {
        sb.getUserCalls++;
        if (sb.getUserThrows) throw new Error("auth down");
        return { data: { user: sb.user } };
      },
    },
    rpc: async () => {
      sb.rpcCalls++;
      if (sb.rpcThrows) throw new Error("rpc down");
      return { data: sb.role };
    },
  }),
}));
vi.mock("./jackboy-tools.server", () => ({ buildJackboyTools: vi.fn(), guardTools: vi.fn() }));

import { verifyOwner } from "./chat.server";

const req = (authorization?: string) =>
  new Request("https://example.test/api/safety-status", authorization ? { headers: { authorization } } : {});

beforeEach(() => {
  Object.assign(sb, { user: { id: "u1" }, role: "owner", getUserThrows: false, rpcThrows: false, getUserCalls: 0, rpcCalls: 0 });
  process.env["SUPABASE_URL"] = "https://isolated.test";
  process.env["SUPABASE_PUBLISHABLE_KEY"] = "isolated-test-key";
});

describe("real owner authorization used by the safety status API", () => {
  it("accepts only a valid session whose role is owner", async () => {
    expect(await verifyOwner(req("Bearer t"))).toBe("u1");
  });
  it("rejects a missing bearer token before contacting the auth provider", async () => {
    expect(await verifyOwner(req())).toBeNull();
    expect(sb.getUserCalls).toBe(0);
  });
  it("rejects a malformed bearer value because the provider finds no user", async () => {
    sb.user = null;
    expect(await verifyOwner(req("Bearer "))).toBeNull();
    expect(sb.rpcCalls).toBe(0);
  });
  it("rejects an invalid or expired session without checking the role", async () => {
    sb.user = null;
    expect(await verifyOwner(req("Bearer t"))).toBeNull();
    expect(sb.rpcCalls).toBe(0);
  });
  it("rejects admins, members and a missing role", async () => {
    for (const role of ["admin", "member", null]) {
      sb.role = role;
      expect(await verifyOwner(req("Bearer t"))).toBeNull();
    }
  });
  it("never resolves to an owner when the auth provider or role lookup fails", async () => {
    sb.getUserThrows = true;
    await expect(verifyOwner(req("Bearer t"))).rejects.toThrow();
    sb.getUserThrows = false;
    sb.rpcThrows = true;
    await expect(verifyOwner(req("Bearer t"))).rejects.toThrow();
  });
});

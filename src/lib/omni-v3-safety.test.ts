import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  policy: vi.fn(),
  rpc: vi.fn(),
  log: vi.fn(),
  verified: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const chain = {
      middleware: () => chain,
      inputValidator: () => chain,
      handler: (fn: unknown) => fn,
    };
    return chain;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.policy }) }) }),
    rpc: mocks.rpc,
  },
}));
vi.mock("./site-log.server", () => ({ logSiteStrict: mocks.log }));
vi.mock("./omni-link.server", () => ({ isOmniVerified: mocks.verified }));

import { executeOmniV3Receipt, OmniDispatchV3Client } from "./omni-dispatch-v3.server";
import { approveOmniReceipt } from "./omni-link.functions";

const owner = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const grant = "33333333-3333-4333-8333-333333333333";
const job = "44444444-4444-4444-8444-444444444444";
const message = "Kill Switch is on — nothing was sent to OMNI.";
const context = {
  userId: owner,
  supabase: {
    rpc: vi.fn().mockResolvedValue({ data: "owner", error: null }),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: owner, email_confirmed_at: "yes" } },
        error: null,
      }),
    },
  },
};
const approve = approveOmniReceipt as unknown as (arg: {
  context: typeof context;
  data: { jobId: string; grantId: string };
}) => Promise<unknown>;

beforeEach(() => {
  vi.stubEnv("JACKBOY_DISPATCH_V3_ENABLED", "true");
  vi.stubEnv("OMNI_DISPATCH_ORIGIN", "https://omni.example");
  vi.stubEnv("OMNI_DISPATCH_CLIENT_ID", "test");
  vi.stubEnv("OMNI_DISPATCH_HMAC_SECRET", "test-secret-012345678901234567890123");
  vi.stubEnv("OMNI_DISPATCH_CA_FILE", "");
  mocks.policy.mockResolvedValue({ data: { paused: true }, error: null });
  mocks.log.mockResolvedValue(undefined);
  mocks.verified.mockResolvedValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("v3 Kill Switch", () => {
  it("blocks submit and approval before any dispatch or grant is issued", async () => {
    await expect(executeOmniV3Receipt(owner, job, grant, "submit")).rejects.toThrow(message);
    await expect(approve({ context, data: { jobId: job, grantId: grant } })).rejects.toThrow(
      message,
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.verified).not.toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledTimes(2);
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "omni.dispatch.v3.blocked_kill_switch",
        detail: { jobId: job },
      }),
    );
  });

  it.each([
    ["read error", { data: null, error: { message: "unavailable" } }],
    ["missing policy", { data: null, error: null }],
    ["malformed policy", { data: { paused: null }, error: null }],
  ])("blocks submit when policy has %s", async (_label, policy) => {
    mocks.policy.mockResolvedValue(policy);
    await expect(executeOmniV3Receipt(owner, job, grant, "submit")).rejects.toThrow(message);
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ detail: { jobId: job } }));
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("fails closed when the policy reader throws", async () => {
    mocks.policy.mockRejectedValue(new Error("database unavailable"));
    await expect(executeOmniV3Receipt(owner, job, grant, "submit")).rejects.toThrow(message);
    expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ detail: { jobId: job } }));
  });

  it.each(["status", "cancel"] as const)("allows %s while paused", async (action) => {
    const scope = {
      ownerId: owner,
      projectId: project,
      grantId: grant,
      jobId: job,
      repo: "acme/repo",
      kind: "test",
      payloadDigest: "a".repeat(64),
    };
    mocks.rpc.mockImplementation(async (_fn: string, params: { _op: string }) =>
      params._op === "read" ? { data: scope, error: null } : { data: true, error: null },
    );
    const send = vi
      .spyOn(OmniDispatchV3Client.prototype, "send")
      .mockResolvedValue({ id: job, status: action === "cancel" ? "cancelled" : "running" });
    await expect(executeOmniV3Receipt(owner, job, grant, action)).resolves.toMatchObject({
      id: job,
    });
    expect(send).toHaveBeenCalledWith(action, scope, undefined, undefined);
    expect(mocks.policy).not.toHaveBeenCalled();
  });

  it.each([3, 5])("rechecks the switch at policy read %i before transport", async (pausedRead) => {
    for (let i = 1; i < pausedRead; i++) {
      mocks.policy.mockResolvedValueOnce({ data: { paused: false }, error: null });
    }
    mocks.policy.mockResolvedValueOnce({ data: { paused: true }, error: null });
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "omni_dispatch_grant_action"
        ? {
            data: {
              valid: true,
              id: grant,
              ownerId: owner,
              projectId: project,
              jobId: job,
              repo: "acme/repo",
              kind: "test",
              instructions: "run tests",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
            error: null,
          }
        : { data: true, error: null },
    );
    await expect(executeOmniV3Receipt(owner, job, grant, "submit")).rejects.toThrow(message);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "omni_dispatch_v3_action",
      expect.objectContaining({ _op: "prepare" }),
    );
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "omni_dispatch_v3_action",
      expect.objectContaining({ _op: "record_response" }),
    );
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: "omni.dispatch.v3.blocked_kill_switch" }),
    );
  });
});

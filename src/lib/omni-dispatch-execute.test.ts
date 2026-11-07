import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  audit: vi.fn(),
  send: vi.fn(),
  readFile: vi.fn(),
  live: vi.fn(),
}));
vi.mock("./omni-link.server", () => ({ isOmniVerified: mocks.live }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("./untyped-db", () => ({ untyped: () => ({ rpc: mocks.rpc }) }));
vi.mock("./site-log.server", () => ({ logSiteStrict: mocks.audit }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("./omni-dispatch-client.server", () => ({
  OmniDispatchClient: class {
    constructor(
      _config: unknown,
      private authorize: (scope: unknown) => Promise<boolean>,
      private audit: (event: string, scope: unknown) => Promise<void>,
    ) {}
    async send(action: string, scope: unknown) {
      if (!(await this.authorize(scope))) throw new Error("Dispatch grant unavailable.");
      await this.audit(`request_${action}`, scope);
      const status = await mocks.send(action, scope);
      await this.audit(`result_${status}`, scope);
      return { status };
    }
  },
}));
import { executeOmniReceipt } from "./omni-dispatch-execute.server";

const owner = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const job = "33333333-3333-4333-8333-333333333333";
const grant = "44444444-4444-4444-8444-444444444444";
const record = {
  valid: true,
  id: grant,
  ownerId: owner,
  projectId: project,
  jobId: job,
  repo: "acme/repo",
  kind: "test",
  instructions: "bounded request",
};

beforeEach(() => {
  vi.stubEnv("OMNI_DISPATCH_ENABLED", "true");
  vi.stubEnv("OMNI_DISPATCH_ORIGIN", "https://localhost");
  vi.stubEnv("OMNI_DISPATCH_CA_FILE", "/test/ca");
  vi.stubEnv("OMNI_DISPATCH_CLIENT_ID", "test");
  vi.stubEnv("OMNI_DISPATCH_HMAC_SECRET", "s".repeat(64));
  mocks.rpc
    .mockReset()
    .mockImplementation((_name: string, args: { _op: string }) =>
      Promise.resolve(
        args._op === "check"
          ? { data: record, error: null }
          : { data: { recorded: true }, error: null },
      ),
    );
  mocks.audit.mockReset().mockResolvedValue(undefined);
  mocks.send.mockReset().mockResolvedValue("quarantined");
  mocks.readFile.mockReset().mockResolvedValue(Buffer.from("ca"));
  mocks.live.mockReset().mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe("owner dispatch wrapper", () => {
  it("rechecks the grant, audits before transport and records the verified result", async () => {
    expect(await executeOmniReceipt(owner, job, grant, "submit")).toEqual({
      status: "quarantined",
    });
    expect(mocks.rpc.mock.calls.filter(([, args]) => args._op === "check")).toHaveLength(2);
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "omni_dispatch_grant_action",
      expect.objectContaining({
        _op: "record_quarantined",
        _actor: owner,
        _job: job,
        _grant: grant,
      }),
    );
    expect(mocks.audit.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      mocks.send.mock.invocationCallOrder[0] ?? -Infinity,
    );
  });
  it("fails closed when disabled or a grant changes before sending", async () => {
    vi.stubEnv("OMNI_DISPATCH_ENABLED", "false");
    await expect(executeOmniReceipt(owner, job, grant, "submit")).rejects.toThrow("disabled");
    vi.stubEnv("OMNI_DISPATCH_ENABLED", "true");
    mocks.rpc
      .mockResolvedValueOnce({ data: record, error: null })
      .mockResolvedValueOnce({ data: { valid: false }, error: null });
    await expect(executeOmniReceipt(owner, job, grant, "submit")).rejects.toThrow(
      "grant unavailable",
    );
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("refuses transport when request audit fails", async () => {
    mocks.audit.mockRejectedValue(new Error("audit failed"));
    await expect(executeOmniReceipt(owner, job, grant, "submit")).rejects.toThrow("audit failed");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("rejects a mismatched returned owner, job or grant", async () => {
    for (const change of [{ ownerId: project }, { jobId: project }, { id: project }]) {
      mocks.rpc.mockResolvedValueOnce({ data: { ...record, ...change }, error: null });
      await expect(executeOmniReceipt(owner, job, grant, "submit")).rejects.toThrow(
        "scope mismatch",
      );
    }
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("reports uncertain outcome without retry when post-transport persistence fails", async () => {
    mocks.rpc.mockImplementation((_name: string, args: { _op: string }) =>
      Promise.resolve(
        args._op === "check" ? { data: record, error: null } : { data: null, error: {} },
      ),
    );
    await expect(executeOmniReceipt(owner, job, grant, "submit")).rejects.toThrow("reconcile");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });
  it("refuses to send when the live link is not verified", async () => {
    mocks.live.mockResolvedValue(false);
    await expect(executeOmniReceipt(owner, job, grant, "submit")).rejects.toThrow("live link");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("stops right before transport if the link drops after the first check", async () => {
    mocks.live.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(executeOmniReceipt(owner, job, grant, "submit")).rejects.toThrow("live link");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("refuses a grant the database reports as revoked and names the reason", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: { valid: false, reason: "authorization_revoked" }, error: null });
    await expect(executeOmniReceipt(owner, job, grant, "submit")).rejects.toThrow("authorization_revoked");
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it("sends a build job to OMNI as kind `build`", async () => {
    mocks.rpc.mockImplementation((_name: string, args: { _op: string }) =>
      Promise.resolve(
        args._op === "check"
          ? { data: { ...record, kind: "code" }, error: null }
          : { data: { recorded: true }, error: null },
      ),
    );
    await executeOmniReceipt(owner, job, grant, "submit");
    expect(mocks.send).toHaveBeenCalledWith("submit", expect.objectContaining({ kind: "build" }));
  });
  it("records cancellation as a terminal receipt", async () => {
    mocks.send.mockResolvedValue("cancelled");
    expect(await executeOmniReceipt(owner, job, grant, "cancel")).toEqual({ status: "cancelled" });
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "omni_dispatch_grant_action",
      expect.objectContaining({ _op: "record_cancelled" }),
    );
  });
});

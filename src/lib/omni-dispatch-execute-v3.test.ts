import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  audit: vi.fn(),
  send: vi.fn(),
  readFile: vi.fn(),
  live: vi.fn(),
  version: [] as string[],
  tables: {} as Record<string, { data: unknown; error: unknown }>,
}));
vi.mock("./omni-link.server", () => ({ isOmniVerified: mocks.live }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("./untyped-db", () => ({
  untyped: () => ({
    rpc: mocks.rpc,
    from: (table: string) => {
      const value = () => Promise.resolve(mocks.tables[table]);
      const chain = {
        select: () => chain,
        eq: () => chain,
        gte: () => value(),
        maybeSingle: () => value(),
      };
      return chain;
    },
  }),
}));
vi.mock("./site-log.server", () => ({ logSiteStrict: mocks.audit }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("./omni-dispatch-client.server", () => ({
  OmniDispatchClient: class {
    constructor(
      _config: unknown,
      private authorize: (scope: unknown) => Promise<boolean>,
      private audit: (event: string, scope: unknown) => Promise<void>,
      version = "v2",
    ) {
      mocks.version.push(version);
    }
    async send(action: string, scope: unknown) {
      if (!(await this.authorize(scope))) throw new Error("Dispatch grant unavailable.");
      await this.audit(`request_${action}`, scope);
      const status = await mocks.send(action, scope);
      await this.audit(`result_${status}`, scope);
      return { id: (scope as { jobId: string }).jobId, status };
    }
  },
}));
import { executeOmniReceipt } from "./omni-dispatch-execute.server";

const owner = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const job = "33333333-3333-4333-8333-333333333333";
const grant = "44444444-4444-4444-8444-444444444444";
const record = () => ({
  valid: true,
  id: grant,
  ownerId: owner,
  projectId: project,
  jobId: job,
  repo: "acme/repo",
  kind: "test",
  instructions: "bounded request",
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
});
let grantRow = record();
const safe = () => ({
  automation_policy: { data: { paused: false }, error: null },
  code_runtime_controls: {
    data: { kill_switch: false, usage_spike: false, consecutive_failures: 0, daily_spend_limit_usd: "5.00" },
    error: null,
  },
  code_usage_events: { data: [{ cost_usd: "0.40" }], error: null },
});

beforeEach(() => {
  vi.stubEnv("OMNI_DISPATCH_ENABLED", "true");
  vi.stubEnv("OMNI_DISPATCH_ORIGIN", "https://localhost");
  vi.stubEnv("OMNI_DISPATCH_CA_FILE", "/test/ca");
  vi.stubEnv("OMNI_DISPATCH_CLIENT_ID", "test");
  vi.stubEnv("OMNI_DISPATCH_HMAC_SECRET", "s".repeat(64));
  vi.stubEnv("OMNI_ALLOWED_REPOS", "acme/repo");
  grantRow = record();
  mocks.tables = safe();
  mocks.version = [];
  mocks.rpc
    .mockReset()
    .mockImplementation((name: string, args: { _op?: string }) =>
      Promise.resolve(
        name === "omni_dispatch_grant_action" && args._op === "check"
          ? { data: grantRow, error: null }
          : { data: { recorded: true }, error: null },
      ),
    );
  mocks.audit.mockReset().mockResolvedValue(undefined);
  mocks.send.mockReset().mockResolvedValue("running");
  mocks.readFile.mockReset().mockResolvedValue(Buffer.from("ca"));
  mocks.live.mockReset().mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe("v3 owner dispatch", () => {
  it("re-checks twice, signs payload + expiry, and records the verified v3 status", async () => {
    expect(await executeOmniReceipt(owner, job, grant, "submit", "v3")).toEqual({ id: job, status: "running" });
    expect(mocks.version).toEqual(["v3"]);
    expect(mocks.rpc.mock.calls.filter(([, a]) => a._op === "check")).toHaveLength(2);
    const sent = mocks.send.mock.calls[0]![1];
    expect(sent).toMatchObject({ payload: "bounded request", kind: "test", repo: "acme/repo" });
    expect(sent.expiresAt).toBe(Math.floor(Date.parse(grantRow.expiresAt) / 1000));
    expect(mocks.rpc).toHaveBeenLastCalledWith("omni_dispatch_v3_record", {
      _source: "dispatch",
      _nonce: null,
      _owner: owner,
      _project: project,
      _job: job,
      _grant: grant,
      _repo: "acme/repo",
      _status: "running",
      _result: null,
    });
  });

  it("keeps OMNI_DISPATCH_ENABLED gating", async () => {
    vi.stubEnv("OMNI_DISPATCH_ENABLED", "false");
    await expect(executeOmniReceipt(owner, job, grant, "submit", "v3")).rejects.toThrow("disabled");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("refuses an expired grant and one expiring more than 30 minutes out", async () => {
    mocks.rpc.mockImplementation((name: string, a: { _op?: string }) =>
      Promise.resolve(
        a._op === "check" ? { data: { valid: false, reason: "grant_expired" }, error: null } : { data: null, error: null },
      ),
    );
    await expect(executeOmniReceipt(owner, job, grant, "submit", "v3")).rejects.toThrow("grant_expired");
    mocks.rpc.mockImplementation(() =>
      Promise.resolve({ data: { ...record(), expiresAt: new Date(Date.now() + 31 * 60_000).toISOString() }, error: null }),
    );
    await expect(executeOmniReceipt(owner, job, grant, "submit", "v3")).rejects.toThrow("30 minutes");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("refuses instructions over 6 KB", async () => {
    grantRow = { ...record(), instructions: "x".repeat(6145) };
    await expect(executeOmniReceipt(owner, job, grant, "submit", "v3")).rejects.toThrow("6 KB");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("Emergency Stop, Kill Switch, spending limits and repo list stay in front of every send", async () => {
    const cases: [string, Record<string, { data: unknown; error: unknown }>, string][] = [
      ["Emergency Stop", { code_runtime_controls: { data: { ...safe().code_runtime_controls.data, kill_switch: true }, error: null } }, "Emergency Stop"],
      ["Emergency Stop unreadable", { code_runtime_controls: { data: null, error: { message: "x" } } }, "Emergency Stop"],
      ["Kill Switch", { automation_policy: { data: { paused: true }, error: null } }, "Kill Switch"],
      ["spend", { code_usage_events: { data: [{ cost_usd: "5.00" }], error: null } }, "spending limit"],
      ["spend unreadable", { code_usage_events: { data: null, error: { message: "x" } } }, "Spending limits"],
      ["spike", { code_runtime_controls: { data: { ...safe().code_runtime_controls.data, usage_spike: true }, error: null } }, "spike"],
    ];
    for (const [, override, message] of cases) {
      mocks.tables = { ...safe(), ...override };
      await expect(executeOmniReceipt(owner, job, grant, "submit", "v3")).rejects.toThrow(message);
    }
    mocks.tables = safe();
    vi.stubEnv("OMNI_ALLOWED_REPOS", "other/repo");
    await expect(executeOmniReceipt(owner, job, grant, "submit", "v3")).rejects.toThrow("OMNI_ALLOWED_REPOS");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("stops right before transport if Emergency Stop engages after the first check", async () => {
    let reads = 0;
    const engaged = { data: { ...safe().code_runtime_controls.data, kill_switch: true }, error: null };
    mocks.tables = new Proxy(safe(), {
      get: (target, key: string) =>
        key === "code_runtime_controls" && ++reads > 1 ? engaged : target[key as keyof typeof target],
    });
    await expect(executeOmniReceipt(owner, job, grant, "submit", "v3")).rejects.toThrow("Emergency Stop");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("v2 still sends through the v2 client and records a v2 receipt", async () => {
    mocks.send.mockResolvedValue("quarantined");
    mocks.tables = { ...safe(), code_runtime_controls: { data: { kill_switch: true }, error: null } };
    expect(await executeOmniReceipt(owner, job, grant, "submit")).toEqual({ id: job, status: "quarantined" });
    expect(mocks.version).toEqual(["v2"]);
    expect(mocks.send.mock.calls[0]![1]).not.toHaveProperty("payload");
    expect(mocks.rpc).toHaveBeenLastCalledWith(
      "omni_dispatch_grant_action",
      expect.objectContaining({ _op: "record_quarantined" }),
    );
  });
});

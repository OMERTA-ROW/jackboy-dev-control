import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  order: vi.fn(),
  limit: vi.fn(),
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const chain = { middleware: () => chain, handler: (fn: unknown) => fn };
    return chain;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { from: mocks.from } }));
import { getOmniV3Results } from "./omni-v3-results.functions";

const run = getOmniV3Results as unknown as (arg: {
  context: {
    userId: string;
    supabase: { rpc: () => Promise<{ data: string | null; error: unknown }> };
  };
}) => Promise<unknown[]>;
const context = (role: string | null, error: unknown = null) => ({
  userId: "owner-id",
  supabase: { rpc: async () => ({ data: role, error }) },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.from.mockReturnValue({ select: mocks.select });
  mocks.select.mockReturnValue({ eq: mocks.eq });
  mocks.eq.mockReturnValue({ order: mocks.order });
  mocks.order.mockReturnValue({ limit: mocks.limit });
  mocks.limit.mockResolvedValue({ data: [], error: null });
});

describe("owner-only v3 results", () => {
  it.each([
    ["member", null],
    [null, { message: "unavailable" }],
    ["owner", { message: "unavailable" }],
  ])("rejects non-owner or failed authorization", async (role, error) => {
    await expect(run({ context: context(role, error) })).rejects.toThrow("Only the owner");
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("scopes the query and returns only safe result fields", async () => {
    const digest = "a".repeat(64);
    const nonce = "b".repeat(32);
    mocks.limit.mockResolvedValue({
      data: [
        {
          job_id: "job",
          kind: "test",
          repo: "acme/repo",
          status: "completed",
          created_at: "2025-01-01",
          updated_at: "2025-01-02",
          expires_at: "2025-01-03",
          payload_digest: digest,
          nonce,
          hmac: digest,
          result: {
            passed: true,
            tests: { passed: 3, failed: 1, total: 4, secret: "hidden" },
            summary: "Completed",
            output: `ok\nnonce=${nonce}\n${digest}\n${"x".repeat(600)}`,
            hmac: digest,
          },
        },
      ],
      error: null,
    });
    const rows = await run({ context: context("owner") });
    expect(mocks.from).toHaveBeenCalledWith("omni_dispatch_v3_jobs");
    expect(mocks.select).toHaveBeenCalledWith(
      "job_id,kind,repo,status,created_at,updated_at,expires_at,result",
    );
    expect(mocks.eq).toHaveBeenCalledWith("owner_id", "owner-id");
    expect(mocks.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(mocks.limit).toHaveBeenCalledWith(20);
    expect(rows).toEqual([
      expect.objectContaining({
        jobId: "job",
        result: expect.objectContaining({
          passed: true,
          testCounts: { passed: 3, failed: 1, total: 4 },
          summary: "Completed",
        }),
      }),
    ]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(digest);
    expect(serialized).not.toContain(nonce);
    expect(serialized).not.toContain("hidden");
    const log = (rows[0] as { result: { log: string } }).result.log;
    expect(Array.from(log).length).toBeLessThanOrEqual(500);
  });

  it("does not turn a database failure into empty success", async () => {
    mocks.limit.mockResolvedValue({ data: null, error: { message: "private database detail" } });
    await expect(run({ context: context("owner") })).rejects.toThrow(
      "OMNI results could not be loaded.",
    );
  });
});

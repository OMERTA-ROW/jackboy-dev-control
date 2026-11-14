import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  single: vi.fn(),
  policy: vi.fn(),
  owner: vi.fn(),
  rpc: vi.fn(),
  token: vi.fn(),
  workflow: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: table === "automation_policy" ? mocks.policy : mocks.single,
          eq: () => ({ maybeSingle: mocks.owner }),
        }),
      }),
    }),
    rpc: mocks.rpc,
  },
}));
vi.mock("./code-runner-auth.server", () => ({
  verifyGithubActionsToken: mocks.token,
  verifyWorkflowRun: mocks.workflow,
}));

import {
  codeGatewayProviderKeyPresent,
  handleCodeProviderRequest,
  productionGatewayDeps,
} from "./code-gateway.server";

const id = "11111111-1111-4111-8111-111111111111";
const sha = "a".repeat(40);
const scope = { repo: "owner/disposable", ref: "main", workflowSha: sha, baseSha: sha };
const allowed = () => ({
  action: "code_workflow",
  status: "allowed",
  revoked_at: null,
  runner_claimed_at: "2026-11-04T00:00:00Z",
  runner_run_id: 7,
  runner_run_attempt: 1,
  resources: scope,
  requested_by: id,
});
const request = (query = `?request_id=${id}`, headers: Record<string, string> = {}) =>
  new Request(`https://staging.invalid/api/public/code/provider/v1/responses${query}`, {
    method: "POST",
    headers: { authorization: "Bearer test-actions-identity", ...headers },
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.token.mockResolvedValue({ run_id: "7", run_attempt: "1" });
  mocks.workflow.mockResolvedValue(undefined);
  mocks.single.mockResolvedValue({ data: allowed(), error: null });
  mocks.owner.mockResolvedValue({ data: { role: "owner" }, error: null });
  mocks.policy.mockResolvedValue({ data: { paused: false }, error: null });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("production gateway authorization wiring (no external requests)", () => {
  it("reports only whether the gateway credential exists", () => {
    vi.stubEnv("CODE_PROVIDER_API_KEY", "");
    expect(codeGatewayProviderKeyPresent()).toBe(false);
    vi.stubEnv("CODE_PROVIDER_API_KEY", "synthetic-server-only");
    expect(codeGatewayProviderKeyPresent()).toBe(true);
  });
  it("binds the Codex endpoint query to the approved repository, workflow and run", async () => {
    expect(await productionGatewayDeps().authenticate(request())).toEqual({
      requestId: id,
      runId: 7,
    });
    expect(mocks.workflow).toHaveBeenCalledWith(
      { run_id: "7", run_attempt: "1" },
      scope.repo,
      scope.ref,
      sha,
      sha,
      "execute",
    );
  });
  it.each([
    ["no identity", () => request("", { authorization: "" })],
    ["no request", () => request("")],
    ["duplicate request", () => request(`?request_id=${id}&request_id=${id}`)],
    [
      "conflicting header",
      () => request(undefined, { "x-code-request-id": "22222222-2222-4222-8222-222222222222" }),
    ],
  ])("rejects %s before workflow lookup", async (_name, req) => {
    await expect(productionGatewayDeps().authenticate(req())).rejects.toThrow();
    expect(mocks.workflow).not.toHaveBeenCalled();
  });
  it.each([
    { status: "pending" },
    { revoked_at: "now" },
    { runner_claimed_at: null },
    { runner_run_id: 8 },
    { runner_run_attempt: 2 },
    { action: "deploy" },
    { resources: { ...scope, baseSha: "" } },
  ])("denies unapproved, revoked or mismatched task %j", async (change) => {
    mocks.single.mockResolvedValue({ data: { ...allowed(), ...change }, error: null });
    await expect(productionGatewayDeps().authenticate(request())).rejects.toThrow();
    expect(mocks.workflow).not.toHaveBeenCalled();
  });
  it("fails closed on database, expired identity and repository-scope verification failures", async () => {
    mocks.single.mockResolvedValueOnce({ data: null, error: { message: "unavailable" } });
    await expect(productionGatewayDeps().authenticate(request())).rejects.toThrow();
    mocks.token.mockRejectedValueOnce(new Error("expired identity"));
    await expect(productionGatewayDeps().authenticate(request())).rejects.toThrow("expired");
    mocks.workflow.mockRejectedValueOnce(new Error("repository mismatch"));
    await expect(productionGatewayDeps().authenticate(request())).rejects.toThrow(
      "repository mismatch",
    );
  });
  it("denies a removed owner or unavailable role evidence", async () => {
    for (const result of [
      { data: null, error: null },
      { data: null, error: { message: "down" } },
    ]) {
      mocks.owner.mockResolvedValueOnce(result);
      await expect(productionGatewayDeps().authenticate(request())).rejects.toThrow(
        "owner authorization",
      );
    }
    expect(mocks.workflow).not.toHaveBeenCalled();
  });
  it("uses the query-bound Actions identity only for auth and the server key only upstream", async () => {
    vi.stubEnv("CODE_PROVIDER_API_KEY", "synthetic-server-only");
    vi.stubEnv(
      "CODE_GATEWAY_PRICES",
      JSON.stringify({
        "m-test": {
          inputPerMillionUsd: 1,
          outputPerMillionUsd: 4,
          maxInputTokens: 1000,
          maxOutputTokens: 100,
        },
      }),
    );
    vi.stubEnv("CODE_GATEWAY_PER_CALL_CAP_USD", "0.1");
    mocks.rpc.mockImplementation(async (name: string) => ({
      data: name === "admit_code_provider_call" ? id : null,
      error: null,
    }));
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-server-only");
      return Response.json({ usage: { input_tokens: 3, output_tokens: 5 } });
    });
    const original = request();
    const response = await handleCodeProviderRequest(
      new Request(original, {
        body: JSON.stringify({ model: "m-test", input: "synthetic input" }),
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.token).toHaveBeenCalledWith("test-actions-identity");
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual([
      "admit_code_provider_call",
      "dispatch_code_provider_call",
      "settle_code_provider_call",
    ]);
    expect(mocks.rpc.mock.calls[0]?.[1]).toMatchObject({ p_request_id: id, p_run_id: 7 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await response.text()).not.toContain("synthetic-server-only");
  });
  it("treats cancellation, run changes and missing controls as stopped", async () => {
    const controls = {
      enabled: true,
      kill_switch: false,
      stop_requested_at: null,
      active_request_id: id,
      active_run_id: 7,
      cancellation_status: "not_needed",
    };
    const deps = productionGatewayDeps();
    for (const change of [
      { kill_switch: true },
      { enabled: false },
      { stop_requested_at: "now" },
      { active_run_id: 8 },
      { cancellation_status: "requested" },
    ]) {
      mocks.single.mockResolvedValueOnce({ data: { ...controls, ...change }, error: null });
      expect(await deps.isStopped({ requestId: id, runId: 7 })).toBe(true);
    }
    mocks.single.mockResolvedValueOnce({ data: null, error: { message: "down" } });
    expect(await deps.isStopped({ requestId: id, runId: 7 })).toBe(true);
    mocks.single.mockResolvedValueOnce({ data: controls, error: null });
    expect(await deps.isStopped({ requestId: id, runId: 7 })).toBe(false);
    for (const policy of [
      { data: { paused: true }, error: null },
      { data: null, error: null },
      { data: { paused: false }, error: { message: "down" } },
    ]) {
      mocks.policy.mockResolvedValueOnce(policy);
      mocks.single.mockResolvedValueOnce({ data: controls, error: null });
      expect(await deps.isStopped({ requestId: id, runId: 7 })).toBe(true);
    }
  });
});

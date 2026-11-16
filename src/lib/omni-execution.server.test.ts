import { describe, expect, it, vi } from "vitest";
import {
  CODE_NOT_READY_MESSAGE,
  classifyAuthorityError,
  executorVerificationFresh,
} from "./omni-execution-refusal";
import { deliverOmniCancellations, handleExecutionControl } from "./omni-execution.server";
import { handleOmniPermit, type PermitStore } from "./omni-permit.server";
import { hmacHex } from "./omni-link";
import { digest, requestMessage } from "./omni-session";

const cancellationMocks = vi.hoisted(() => ({
  pending: vi.fn(),
  ack: vi.fn(),
  request: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({ select: () => ({ eq: () => ({ limit: cancellationMocks.pending }) }) }),
    rpc: cancellationMocks.ack,
  },
}));
vi.mock("./omni-executor-client", () => ({ signedExecutorRequest: cancellationMocks.request }));

const project = "11111111-1111-4111-8111-111111111111";
const env = {
  OMNI_LINK_ENABLED: "true",
  OMNI_LINK_CLIENT_ID: "fixture",
  OMNI_LINK_OWNER_ID: "22222222-2222-4222-8222-222222222222",
  OMNI_LINK_PROJECT_ID: project,
  OMNI_LINK_HMAC_SECRET: "s".repeat(32),
  OMNI_LINK_BOOTSTRAP_KEY: "b".repeat(32),
  OMNI_EXECUTOR_PERMISSION_SECRET: "p".repeat(32),
  OMNI_EXECUTOR_PERMISSION_TOKEN: "t".repeat(32),
  OMNI_AUTONOMY_REVIEWED_RELEASE: "omni-bounded-plan-1",
};
const approval = {
  approvalId: "33333333-3333-4333-8333-333333333333",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};
async function request(operation: string, audience = "mothership", args = {}) {
  const token =
    audience === "executor" ? env.OMNI_EXECUTOR_PERMISSION_TOKEN : env.OMNI_LINK_BOOTSTRAP_KEY;
  const secret =
    audience === "executor" ? env.OMNI_EXECUTOR_PERMISSION_SECRET : env.OMNI_LINK_HMAC_SECRET;
  const body = JSON.stringify({
    action: "execution-control",
    projectId: project,
    operation,
    audience,
    args,
  });
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const ts = String(Math.floor(Date.now() / 1000));
  return new Request("https://jackboy.invalid/api/public/omni/link", {
    method: "POST",
    body,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Omni-Client": env.OMNI_LINK_CLIENT_ID,
      "X-Omni-Nonce": nonce,
      "X-Omni-Timestamp": ts,
      "X-Omni-Signature": await hmacHex(
        secret,
        requestMessage(ts, nonce, await digest(token), body),
      ),
    },
  });
}
function dependencies() {
  return {
    env,
    approval,
    nonce: vi.fn(async () => {}),
    store: vi.fn(async () => ({
      connected: true,
      configured: true,
      armed: false,
      executionReady: false,
    })),
    readiness: vi.fn(async () => {}),
    inspect: vi.fn(async () => ({
      release: "omni-bounded-plan-1",
      enabled: false,
      reviewedRelease: "omni-bounded-plan-1",
    })),
    verify: vi.fn(async () => ({ passed: true, release: "omni-bounded-plan-1" })),
    cancel: vi.fn(async () => ({ pending: 0, unavailable: 0 })),
    audit: vi.fn(async (..._args: unknown[]) => {}),
    connection: vi.fn(async (_project: string) => ({
      verifiedAt: new Date(Date.now() - 60_000).toISOString(),
      executorRelease: "omni-bounded-plan-1" as string | null,
    })),
  };
}
it("Step 10 inspects the signed runner configuration but starts nothing", async () => {
  const deps = dependencies();
  const response = await handleExecutionControl(await request("configure"), deps);
  expect(response.status).toBe(200);
  expect(deps.readiness).toHaveBeenCalledOnce();
  expect(deps.inspect).toHaveBeenCalledOnce();
  expect(deps.verify).not.toHaveBeenCalled();
  expect(deps.store).toHaveBeenCalledWith(
    env.OMNI_LINK_OWNER_ID,
    project,
    approval.approvalId,
    "configure",
    { release: "omni-bounded-plan-1", clientId: "fixture" },
  );
  expect(response.headers.get("X-Omni-Proof")).toMatch(/^[a-f0-9]{64}$/);
});
it("expired approval or disabled link denies activation and execution", async () => {
  for (const operation of [
    "connect",
    "configure",
    "arm",
    "authorize",
    "lease",
    "claim",
    "permission",
  ]) {
    const deps = dependencies();
    deps.approval = { ...approval, expiresAt: new Date(Date.now() - 1000).toISOString() };
    expect(
      (
        await handleExecutionControl(
          await request(
            operation,
            ["claim", "permission"].includes(operation) ? "executor" : "mothership",
          ),
          deps,
        )
      ).status,
    ).toBe(403);
    expect(deps.store).not.toHaveBeenCalled();
  }
});
it("executor credentials cannot change controls and Mothership cannot claim execution", async () => {
  const deps = dependencies();
  expect((await handleExecutionControl(await request("arm", "executor"), deps)).status).toBe(403);
  expect((await handleExecutionControl(await request("lease", "executor"), deps)).status).toBe(403);
  expect((await handleExecutionControl(await request("claim"), deps)).status).toBe(403);
  expect(deps.store).not.toHaveBeenCalled();
});
it("runner failure or unreviewed release does not persist configuration", async () => {
  const deps = dependencies();
  deps.inspect.mockRejectedValueOnce(new Error("fixture credentials must never be returned"));
  const response = await handleExecutionControl(await request("configure"), deps);
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("credentials");
  expect(deps.store).not.toHaveBeenCalled();
});
it("missing isolated executor configuration keeps Step 10 blocked", async () => {
  const deps = dependencies();
  const { inspect: _inspect, ...withoutInspect } = deps;
  vi.stubEnv("OMNI_EXECUTOR_ORIGIN", "");
  vi.stubEnv("OMNI_EXECUTOR_CONTROL_SECRET", "");
  try {
    const response = await handleExecutionControl(await request("configure"), withoutInspect);
    expect(response.status).toBe(503);
    expect(deps.store).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});
it("disarming persists first and an unconfirmed cancellation is an explicit failure", async () => {
  const deps = dependencies();
  deps.cancel.mockResolvedValueOnce({ pending: 1, unavailable: 1 });
  const response = await handleExecutionControl(await request("disarm"), deps);
  expect(response.status).toBe(503);
  expect(deps.store).toHaveBeenCalledWith(
    env.OMNI_LINK_OWNER_ID,
    project,
    approval.approvalId,
    "disarm",
    { clientId: "fixture" },
  );
  expect(await response.json()).toMatchObject({ error: "cancellation_unverified" });
});
it("nonce store failures refuse the request before any operation", async () => {
  const deps = dependencies();
  deps.nonce.mockRejectedValueOnce(new Error("duplicate"));
  expect((await handleExecutionControl(await request("configure"), deps)).status).toBe(503);
  expect(deps.store).not.toHaveBeenCalled();
});

async function permitRequest(action: string, extra = {}, token = "u".repeat(32)) {
  const body = JSON.stringify({ action, projectId: project, ...extra });
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const ts = String(Math.floor(Date.now() / 1000));
  return new Request("https://jackboy.invalid/api/public/omni/link", {
    method: "POST",
    body,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Omni-Client": env.OMNI_LINK_CLIENT_ID,
      "X-Omni-Nonce": nonce,
      "X-Omni-Timestamp": ts,
      "X-Omni-Signature": await hmacHex(
        env.OMNI_LINK_HMAC_SECRET,
        requestMessage(ts, nonce, await digest(token), body),
      ),
    },
  });
}
async function runPermit(request: Request, store: PermitStore) {
  return handleOmniPermit(
    request,
    await request.clone().text(),
    {
      clientId: env.OMNI_LINK_CLIENT_ID,
      projectId: project,
      ownerId: env.OMNI_LINK_OWNER_ID,
      approvalId: approval.approvalId,
      approvalExpiresAt: approval.expiresAt,
      bootstrap: env.OMNI_LINK_BOOTSTRAP_KEY,
      secret: env.OMNI_LINK_HMAC_SECRET,
    },
    store,
    env,
  );
}
it("safety uses a current session, reports actual issued permits, and keeps CODE Stop independent of manual diagnostics", async () => {
  const session = vi.fn(async () => ({
    http: 200,
    safety: {
      checkedAt: new Date().toISOString(),
      connected: true,
      configured: true,
      armed: false,
      emergencyStop: true,
      killSwitch: false,
      codeEnabled: false,
      executionReady: false,
      expiresAt: approval.expiresAt,
      operationId: approval.approvalId,
      running: false,
      cancellationPending: false,
      activePermits: 1,
      autonomousAllowed: false,
      manualDiagnosticsAllowed: true,
    },
  }));
  const req = await permitRequest("safety");
  const response = await runPermit(req, session);
  expect(response.status).toBe(200);
  expect((await response.clone().json()).safety).toMatchObject({
    emergencyStop: true,
    autonomousAllowed: false,
    manualDiagnosticsAllowed: true,
    activePermits: 1,
  });
  const body = await response.text();
  expect(response.headers.get("X-Omni-Proof")).toBe(
    await hmacHex(
      env.OMNI_LINK_HMAC_SECRET,
      `omni.link/v2\nresponse\n${req.headers.get("X-Omni-Nonce")}\n200\n${body}`,
    ),
  );
  expect(session).toHaveBeenCalledWith(
    "safety",
    expect.objectContaining({
      clientId: "fixture",
      projectId: project,
      tokenHash: await digest("u".repeat(32)),
    }),
  );
});
it("bootstrap is never a permit session; CODE permits retain the upstream owner gate", async () => {
  const session = vi.fn(async () => ({
    http: 403,
    error: "permit_denied",
    reason: "not_authorized",
  }));
  expect(
    (await runPermit(await permitRequest("safety", {}, env.OMNI_LINK_BOOTSTRAP_KEY), session))
      .status,
  ).toBe(401);
  const extra = {
    jobId: crypto.randomUUID(),
    kind: "code",
    digest: "a".repeat(64),
    estimateUsd: 0.01,
  };
  expect((await runPermit(await permitRequest("permit.request", extra), session)).status).toBe(403);
  expect(session).toHaveBeenCalledOnce();
});
it("permits bind job, digest, session scope and expiry with the canonical signature", async () => {
  const extra = {
    jobId: crypto.randomUUID(),
    kind: "autonomous",
    digest: "a".repeat(64),
    estimateUsd: 0.01,
  };
  const row = {
    id: crypto.randomUUID(),
    jobId: extra.jobId,
    digest: extra.digest,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 50_000).toISOString(),
    renewals: 0,
    kind: "autonomous",
    status: "active",
  };
  const session = vi.fn(async () => ({ http: 200, permit: row }));
  const response = await runPermit(await permitRequest("permit.request", extra), session);
  expect(response.status).toBe(200);
  const permit = (await response.json()).permit;
  expect(permit.signature).toBe(
    await hmacHex(
      env.OMNI_LINK_HMAC_SECRET,
      [
        "omni.permit/v1",
        row.id,
        extra.jobId,
        "autonomous",
        extra.digest,
        env.OMNI_LINK_CLIENT_ID,
        project,
        approval.approvalId,
        row.expiresAt,
      ].join("\n"),
    ),
  );
  session.mockRejectedValueOnce(new Error("private session detail"));
  const denied = await runPermit(await permitRequest("permit.request", extra), session);
  expect(denied.status).toBe(503);
  expect(await denied.text()).not.toContain("private");
});
it("permit release uses the upstream terminal record and never claims worker cancellation", async () => {
  const session = vi.fn(async () => ({ http: 200, permit: { status: "released" } }));
  const result = await runPermit(
    await permitRequest("permit.release", { jobId: crypto.randomUUID() }),
    session,
  );
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ permit: { status: "released" } });
  expect(session).toHaveBeenCalledWith("release", expect.any(Object));
});

it.each([
  { claimed: false, reachable: false, ackError: false, unavailable: 0 },
  { claimed: true, reachable: false, ackError: false, unavailable: 1 },
  { claimed: true, reachable: true, ackError: false, unavailable: 0 },
  { claimed: true, reachable: true, ackError: true, unavailable: 1 },
])(
  "cancellation acknowledges only an unclaimed job or a verified worker termination: %j",
  async (c) => {
    const job = {
      id: crypto.randomUUID(),
      plan_sha256: "a".repeat(64),
      claimed_at: c.claimed ? new Date().toISOString() : null,
    };
    cancellationMocks.pending.mockReset().mockResolvedValue({ data: [job], error: null });
    cancellationMocks.ack
      .mockReset()
      .mockResolvedValue({ error: c.ackError ? { message: "down" } : null });
    cancellationMocks.request.mockReset();
    if (c.reachable) cancellationMocks.request.mockResolvedValue({ cancelled: true });
    else cancellationMocks.request.mockRejectedValue(new Error("job_not_owned_by_instance"));
    vi.stubEnv("OMNI_EXECUTOR_ORIGIN", "https://isolated-worker.up.railway.app");
    vi.stubEnv("OMNI_EXECUTOR_CONTROL_SECRET", "s".repeat(32));
    try {
      expect(await deliverOmniCancellations()).toEqual({ pending: 1, unavailable: c.unavailable });
      expect(cancellationMocks.request).toHaveBeenCalledTimes(c.claimed ? 1 : 0);
      expect(cancellationMocks.ack).toHaveBeenCalledTimes(!c.claimed || c.reachable ? 1 : 0);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it("authenticated refusals are signed, carry the real reason and are audited", async () => {
  const deps = dependencies();
  deps.inspect.mockResolvedValueOnce({
    release: "omni-bounded-plan-1",
    enabled: false,
    reviewedRelease: null,
  } as never);
  const req = await request("configure");
  const nonce = req.headers.get("x-omni-nonce")!;
  const response = await handleExecutionControl(req, deps);
  expect(response.status).toBe(403);
  const raw = await response.text();
  expect(JSON.parse(raw)).toEqual({ contract: "omni.link/v2", requestNonce: nonce, error: "release_unreviewed" });
  const { hmacHex } = await import("./omni-link");
  expect(response.headers.get("X-Omni-Proof")).toBe(
    await hmacHex(env.OMNI_LINK_HMAC_SECRET, `omni.link/v2\nresponse\n${nonce}\n403\n${raw}`),
  );
  expect(deps.audit).toHaveBeenCalledWith(project, "configure", "release_unreviewed");
  expect(deps.store).not.toHaveBeenCalled();
});
it("failed authentication stays unsigned and unaudited", async () => {
  const deps = dependencies();
  const req = await request("configure");
  req.headers.set("x-omni-client", "someone-else");
  const response = await handleExecutionControl(req, deps);
  expect(response.status).toBe(401);
  expect(response.headers.get("X-Omni-Proof")).toBeNull();
  expect(deps.audit).not.toHaveBeenCalled();
});

describe("Step 10 names the real refusal instead of a generic 503", () => {
  it("configure right after a reconnect (no verification) is a signed 409 and stores nothing", async () => {
    const deps = dependencies();
    deps.connection.mockResolvedValueOnce({ verifiedAt: null, executorRelease: null } as never);
    const req = await request("configure");
    const nonce = req.headers.get("x-omni-nonce")!;
    const response = await handleExecutionControl(req, deps);
    expect(response.status).toBe(409);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({
      contract: "omni.link/v2",
      requestNonce: nonce,
      error: "executor_verification_required",
    });
    expect(response.headers.get("X-Omni-Proof")).toBe(
      await hmacHex(env.OMNI_LINK_HMAC_SECRET, `omni.link/v2\nresponse\n${nonce}\n409\n${raw}`),
    );
    expect(deps.connection).toHaveBeenCalledWith(project);
    expect(deps.store).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledWith(project, "configure", "executor_verification_required");
  });
  it("a verification older than 15 minutes or for another release is refused the same way", async () => {
    for (const row of [
      { verifiedAt: new Date(Date.now() - 16 * 60_000).toISOString(), executorRelease: "omni-bounded-plan-1" },
      { verifiedAt: new Date().toISOString(), executorRelease: "omni-bounded-plan-0" },
    ]) {
      const deps = dependencies();
      deps.connection.mockResolvedValueOnce(row);
      const response = await handleExecutionControl(await request("configure"), deps);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "executor_verification_required" });
      expect(deps.store).not.toHaveBeenCalled();
    }
  });
  it("a database refusal is classified, signed with its stage and audited with a redacted detail", async () => {
    const { ExecutionAuthorityError } = await import("./omni-execution.server");
    const deps = dependencies();
    deps.store.mockRejectedValueOnce(
      new ExecutionAuthorityError("Fresh Jackboy owner authorization required", "P0001"),
    );
    const response = await handleExecutionControl(await request("configure"), deps);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "owner_authorization_required",
      stage: "authority",
    });
    expect(deps.audit).toHaveBeenCalledWith(
      project,
      "configure",
      "owner_authorization_required",
      expect.objectContaining({
        stage: "authority",
        detail: expect.objectContaining({ code: "P0001" }),
      }),
    );
  });
  it("an unknown database failure stays 503 but records the stage and never returns the message", async () => {
    const { ExecutionAuthorityError } = await import("./omni-execution.server");
    const deps = dependencies();
    deps.store.mockRejectedValueOnce(
      new ExecutionAuthorityError("lock timeout for Bearer abcdefghijklmnopqrstuv", "55P03"),
    );
    const response = await handleExecutionControl(await request("configure"), deps);
    expect(response.status).toBe(503);
    const raw = await response.text();
    expect(JSON.parse(raw)).toMatchObject({
      error: "execution_control_unavailable",
      stage: "authority",
    });
    expect(raw).not.toContain("lock timeout");
    const diagnostic = deps.audit.mock.calls[0]![3] as { detail: { message: string } };
    expect(diagnostic.detail.message).toContain("lock timeout");
    expect(diagnostic.detail.message).not.toContain("abcdefghijklmnopqrstuv");
  });
  it("unmet CODE readiness is a 409, not an outage", async () => {
    const deps = dependencies();
    deps.readiness.mockRejectedValueOnce(new Error(CODE_NOT_READY_MESSAGE));
    const response = await handleExecutionControl(await request("configure"), deps);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "code_configuration_not_ready",
      stage: "readiness",
    });
    expect(deps.inspect).not.toHaveBeenCalled();
    expect(deps.store).not.toHaveBeenCalled();
  });
  it("a malformed request is an unsigned 400 before authentication, not a 503", async () => {
    const deps = dependencies();
    const response = await handleExecutionControl(
      new Request("https://jackboy.invalid/api/public/omni/link", { method: "POST", body: "{not json" }),
      deps,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(response.headers.get("X-Omni-Proof")).toBeNull();
    expect(deps.audit).not.toHaveBeenCalled();
  });
});

describe("refusal rules", () => {
  it("maps each known database refusal and leaves unknown ones as unavailable", () => {
    expect(classifyAuthorityError("CODE spend enforcement is not verified")).toEqual({
      status: 409,
      error: "spend_enforcement_unverified",
    });
    expect(classifyAuthorityError("Connection is not authorized")?.error).toBe(
      "connection_not_authorized",
    );
    expect(classifyAuthorityError("something else")).toBeNull();
    expect(classifyAuthorityError(undefined)).toBeNull();
  });
  it("verification is fresh only inside 15 minutes and for the same release", () => {
    const now = Date.parse("2026-11-16T21:39:18Z");
    const at = (min: number) => new Date(now - min * 60_000).toISOString();
    expect(executorVerificationFresh({ verifiedAt: at(14), executorRelease: "r1" }, "r1", now)).toBe(true);
    expect(executorVerificationFresh({ verifiedAt: at(15), executorRelease: "r1" }, "r1", now)).toBe(false);
    expect(executorVerificationFresh({ verifiedAt: at(1), executorRelease: "r0" }, "r1", now)).toBe(false);
    expect(executorVerificationFresh({ verifiedAt: null, executorRelease: null }, "r1", now)).toBe(false);
    expect(executorVerificationFresh(null, "r1", now)).toBe(false);
  });
});

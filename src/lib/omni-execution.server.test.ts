import { expect, it, vi } from "vitest";
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
  expect(await response.json()).toEqual({ error: "cancellation_unverified" });
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

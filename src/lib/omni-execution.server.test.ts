import { expect, it, vi } from "vitest";
import { handleExecutionControl, handleExecutionPermit } from "./omni-execution.server";
import { hmacHex } from "./omni-link";
import { digest, requestMessage } from "./omni-session";

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
    { release: "omni-bounded-plan-1" },
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
    {},
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
it("safety uses a current session, reports actual issued permits, and keeps CODE Stop independent of manual diagnostics", async () => {
  const session = vi.fn(async () => ({
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
  }));
  const req = await permitRequest("safety");
  const response = await handleExecutionPermit(req, { ...dependencies(), session });
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
  expect(session).toHaveBeenCalledWith("safety", {}, await digest("u".repeat(32)));
});
it("bootstrap is never a permit session and unsupported CODE permits are not rerouted", async () => {
  const session = vi.fn();
  expect(
    (
      await handleExecutionPermit(await permitRequest("safety", {}, env.OMNI_LINK_BOOTSTRAP_KEY), {
        ...dependencies(),
        session,
      })
    ).status,
  ).toBe(401);
  const extra = {
    jobId: crypto.randomUUID(),
    kind: "code",
    digest: "a".repeat(64),
    estimateUsd: 0.01,
  };
  expect(
    (
      await handleExecutionPermit(await permitRequest("permit.request", extra), {
        ...dependencies(),
        session,
      })
    ).status,
  ).toBe(403);
  expect(session).not.toHaveBeenCalled();
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
  };
  const session = vi.fn(async () => row);
  const response = await handleExecutionPermit(await permitRequest("permit.request", extra), {
    ...dependencies(),
    session,
  });
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
  const denied = await handleExecutionPermit(await permitRequest("permit.request", extra), {
    ...dependencies(),
    session,
  });
  expect(denied.status).toBe(503);
  expect(await denied.text()).not.toContain("private");
});
it("permit release does not claim success before durable cancellation delivery is confirmed", async () => {
  const session = vi.fn(async () => ({}));
  const deps = { ...dependencies(), session };
  deps.cancel.mockResolvedValueOnce({ pending: 1, unavailable: 1 });
  expect(
    (
      await handleExecutionPermit(
        await permitRequest("permit.release", { jobId: crypto.randomUUID() }),
        deps,
      )
    ).status,
  ).toBe(503);
  expect(session).toHaveBeenCalled();
});

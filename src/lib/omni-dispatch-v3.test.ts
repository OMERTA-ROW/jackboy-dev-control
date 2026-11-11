import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hmacHex } from "./omni-link";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("./untyped-db", () => ({ untyped: () => ({ rpc: mocks.rpc }) }));
vi.mock("./site-log.server", () => ({ logSiteStrict: vi.fn(), logSite: vi.fn() }));

import {
  cancelRevokedOmniV3Receipts,
  executeOmniV3Receipt,
  handleDispatchV3Callback,
  OmniDispatchV3Client,
} from "./omni-dispatch-v3.server";

const requestContract = "jackboy.dispatch/v3";
const callbackContract = "jackboy.dispatch-callback/v3";
const dispatchPath = "/api/public/jackboy/dispatch";
const callbackPath = "/api/public/omni/callback";
const clientId = "jackboy-test";
const secret = "v3-test-secret-0123456789-0123456789";
const scope = {
  ownerId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  grantId: "33333333-3333-4333-8333-333333333333",
  jobId: "44444444-4444-4444-8444-444444444444",
  repo: "acme/repo",
  kind: "test" as const,
  payloadDigest: "a".repeat(64),
};
const callbackBase = {
  contract: callbackContract,
  ownerId: scope.ownerId,
  projectId: scope.projectId,
  grantId: scope.grantId,
  jobId: scope.jobId,
  repo: scope.repo,
  payloadDigest: scope.payloadDigest,
};

function omniHmac(canonical: string) {
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

async function callbackRequest(
  data: unknown,
  options: { nonce?: string; timestamp?: string; secret?: string; raw?: string } = {},
) {
  const raw = options.raw ?? JSON.stringify(data);
  const nonce = options.nonce ?? "b".repeat(32);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", options.secret ?? secret)
    .update(
      `${callbackContract}\nPOST\n${callbackPath}\n${clientId}\n${timestamp}\n${nonce}\n${raw}`,
      "utf8",
    )
    .digest("hex");
  return new Request(`https://jackboy.example${callbackPath}`, {
    method: "POST",
    headers: {
      "x-omni-contract": callbackContract,
      "x-omni-client": clientId,
      "x-omni-timestamp": timestamp,
      "x-omni-nonce": nonce,
      "x-omni-signature": signature,
    },
    body: raw,
  });
}

function makeClient(
  transport: ConstructorParameters<typeof OmniDispatchV3Client>[3],
  authorize = vi.fn().mockResolvedValue(undefined),
  audit = vi.fn().mockResolvedValue(undefined),
) {
  return {
    client: new OmniDispatchV3Client(
      { origin: "https://omni.example", ca: Buffer.from("test-ca"), clientId, secret },
      authorize,
      audit,
      transport,
    ),
    authorize,
    audit,
  };
}

function responseFor(
  secretKey: string,
  nonce: string,
  status: number,
  jobStatus: string,
  jobId = scope.jobId,
) {
  const body = JSON.stringify({
    contract: requestContract,
    requestNonce: nonce,
    job: { id: jobId, status: jobStatus },
  });
  const proof = createHmac("sha256", secretKey)
    .update(`${requestContract}\nresponse\n${nonce}\n${status}\n${body}`, "utf8")
    .digest("hex");
  return { status, body, proof };
}

describe("Jackboy scoped dispatch v3", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("sends a signed cancellation for every persistently recorded revoked v3 scope", async () => {
    vi.stubEnv("JACKBOY_DISPATCH_V3_ENABLED", "true");
    mocks.rpc.mockResolvedValue({
      data: [
        { jobId: scope.jobId, grantId: scope.grantId },
        {
          jobId: "55555555-5555-4555-8555-555555555555",
          grantId: "66666666-6666-4666-8666-666666666666",
        },
      ],
      error: null,
    });
    const send = vi.fn().mockResolvedValue({ status: "cancelled" });
    await cancelRevokedOmniV3Receipts(scope.ownerId, send);
    expect(mocks.rpc).toHaveBeenCalledWith("omni_dispatch_v3_pending_cancellations", {
      _actor: scope.ownerId,
    });
    expect(send).toHaveBeenNthCalledWith(1, scope.ownerId, scope.jobId, scope.grantId, "cancel");
    expect(send).toHaveBeenNthCalledWith(
      2,
      scope.ownerId,
      "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666",
      "cancel",
    );
  });

  it("keeps sweeping and does not throw when one signed cancel fails", async () => {
    vi.stubEnv("JACKBOY_DISPATCH_V3_ENABLED", "true");
    const second = "55555555-5555-4555-8555-555555555555";
    mocks.rpc.mockResolvedValue({
      data: [
        { jobId: scope.jobId, grantId: scope.grantId },
        { jobId: second, grantId: "66666666-6666-4666-8666-666666666666" },
      ],
      error: null,
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("Dispatch timed out."))
      .mockResolvedValueOnce({ status: "cancelled" });
    const sweep = await cancelRevokedOmniV3Receipts(scope.ownerId, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sweep).toEqual({ attempted: 2, failed: [scope.jobId], lookupFailed: false });
  });

  it("does not throw when pending cancellations cannot be listed", async () => {
    vi.stubEnv("JACKBOY_DISPATCH_V3_ENABLED", "true");
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "boom" } });
    const send = vi.fn();
    const sweep = await cancelRevokedOmniV3Receipts(scope.ownerId, send);
    expect(send).not.toHaveBeenCalled();
    expect(sweep.lookupFailed).toBe(true);
  });

  it("strict mode still refuses to report success when a cancel fails", async () => {
    vi.stubEnv("JACKBOY_DISPATCH_V3_ENABLED", "true");
    mocks.rpc.mockResolvedValue({
      data: [{ jobId: scope.jobId, grantId: scope.grantId }],
      error: null,
    });
    const send = vi.fn().mockRejectedValue(new Error("Dispatch failed with HTTP 404."));
    await expect(
      cancelRevokedOmniV3Receipts(scope.ownerId, send, { strict: true }),
    ).rejects.toThrow("Signed OMNI cancellation failed for 1 v3 job(s).");
  });

  it.each([
    ["submit", 202, "approved"],
    ["status", 200, "running"],
    ["cancel", 200, "cancelled"],
  ] as const)(
    "sends a correctly signed %s request and validates its response proof",
    async (action, status, jobStatus) => {
      const calls: { url?: URL; options?: unknown; body?: string } = {};
      const transport = vi.fn(async (url: URL, options: unknown, body: string) => {
        calls.url = url;
        calls.options = options;
        calls.body = body;
        const requestHeaders = (options as { headers: Record<string, string> }).headers;
        expect(requestHeaders["x-jackboy-signature"]).toBe(
          createHmac("sha256", secret)
            .update(
              `${requestContract}\nPOST\n${dispatchPath}\n${clientId}\n${requestHeaders["x-jackboy-timestamp"]}\n${requestHeaders["x-jackboy-nonce"]}\n${body}`,
              "utf8",
            )
            .digest("hex"),
        );
        return responseFor(secret, requestHeaders["x-jackboy-nonce"]!, status, jobStatus);
      });
      const { client, authorize, audit } = makeClient(transport);
      const payload = action === "submit" ? "run the approved test" : undefined;
      const expiresAt = action === "submit" ? Math.floor(Date.now() / 1000) + 60 : undefined;
      await expect(client.send(action, scope, payload, expiresAt)).resolves.toEqual({
        id: scope.jobId,
        status: jobStatus,
      });
      expect(calls.url?.toString()).toBe(`https://omni.example${dispatchPath}`);
      expect(calls.body).toBeDefined();
      expect(Buffer.byteLength(calls.body!, "utf8")).toBeLessThanOrEqual(8192);
      const requestBody = JSON.parse(calls.body!) as Record<string, unknown>;
      expect(requestBody).toMatchObject({ contract: requestContract, action, ...scope });
      if (action === "submit") {
        expect(requestBody).toMatchObject({ payload, expiresAt });
      } else {
        expect(requestBody).not.toHaveProperty("payload");
        expect(requestBody).not.toHaveProperty("expiresAt");
      }
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(audit).toHaveBeenCalledWith(`result_${jobStatus}`, scope, jobStatus);
    },
  );

  it("rejects a response-proof mismatch and rechecks authorization immediately before transport", async () => {
    const transport = vi.fn(async (_url: URL, options: unknown) => {
      const headers = (options as { headers: Record<string, string> }).headers;
      return {
        ...responseFor(secret, headers["x-jackboy-nonce"]!, 200, "running"),
        proof: "0".repeat(64),
      };
    });
    const authorize = vi.fn().mockResolvedValue(undefined);
    const { client } = makeClient(transport, authorize);
    await expect(client.send("status", scope)).rejects.toThrow("Invalid dispatch response proof");
    expect(authorize).toHaveBeenCalledTimes(2);

    authorize
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("grant revoked"));
    await expect(client.send("status", scope)).rejects.toThrow("grant revoked");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized payloads, oversized escaped envelopes, and expired jobs before authorization", async () => {
    const transport = vi.fn();
    const authorize = vi.fn();
    const { client } = makeClient(transport, authorize);
    const future = Math.floor(Date.now() / 1000) + 60;
    await expect(client.send("submit", scope, "🙂".repeat(1537), future)).rejects.toThrow(
      "6144 UTF-8 bytes",
    );
    await expect(client.send("submit", scope, '"\\\n'.repeat(1500), future)).rejects.toThrow(
      "8192 UTF-8 bytes",
    );
    await expect(
      client.send("submit", scope, "small", Math.floor(Date.now() / 1000) - 1),
    ).rejects.toThrow("within the next 30 minutes");
    expect(authorize).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ["unset", undefined, "disabled"],
    ["false", "false", "disabled"],
    ["uppercase", "TRUE", "disabled"],
    ["exact true", "true", "configuration is incomplete"],
  ] as const)("applies the exact sender feature gate for %s", async (_label, enabled, message) => {
    vi.stubEnv("JACKBOY_DISPATCH_V3_ENABLED", enabled);
    vi.stubEnv("OMNI_DISPATCH_ORIGIN", "https://omni.example");
    vi.stubEnv("OMNI_DISPATCH_CA_FILE", "");
    vi.stubEnv("OMNI_DISPATCH_CLIENT_ID", "");
    vi.stubEnv("OMNI_DISPATCH_HMAC_SECRET", "");
    await expect(
      executeOmniV3Receipt(scope.ownerId, scope.jobId, scope.grantId, "status"),
    ).rejects.toThrow(message);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("OMNI v3 callback receiver", () => {
  const settings = { clientId, secret };

  it("accepts the OMNI Go signer canonical bytes and returns a matching signed acknowledgement", async () => {
    const nonce = "c".repeat(32);
    const result = {
      passed: true,
      summary: "Passed ✅",
      output: "synthetic output",
      truncated: false,
    };
    const callback = { ...callbackBase, status: "completed", result };
    const store = vi.fn().mockResolvedValue(undefined);
    const response = await handleDispatchV3Callback(
      await callbackRequest(callback, { nonce }),
      settings,
      store,
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(store).toHaveBeenCalledWith(nonce, callback);
    expect(response.headers.get("x-omni-proof")).toBe(
      omniHmac(`${callbackContract}\nresponse\n${nonce}\n200\n${body}`),
    );
    expect(JSON.parse(body)).toEqual({
      contract: callbackContract,
      requestNonce: nonce,
      status: "completed",
    });
  });

  it("rejects bad signatures and stale timestamps before persistence", async () => {
    const callback = { ...callbackBase, status: "quarantined" };
    const store = vi.fn();
    expect(
      (
        await handleDispatchV3Callback(
          await callbackRequest(callback, { secret: "wrong" }),
          settings,
          store,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleDispatchV3Callback(
          await callbackRequest(callback, { timestamp: "1000000000" }),
          settings,
          store,
        )
      ).status,
    ).toBe(401);
    expect(store).not.toHaveBeenCalled();
  });

  it("requires the exact opt-in and rejects oversized, duplicate-key, or invalid terminal results", async () => {
    const store = vi.fn().mockResolvedValue(undefined);
    for (const disabledValue of [undefined, "false", "TRUE"] as const) {
      vi.stubEnv("JACKBOY_DISPATCH_V3_ENABLED", disabledValue);
      expect(
        (
          await handleDispatchV3Callback(
            await callbackRequest({ ...callbackBase, status: "quarantined" }),
            undefined,
            store,
          )
        ).status,
      ).toBe(503);
    }
    vi.stubEnv("JACKBOY_DISPATCH_V3_ENABLED", "true");
    const tooLarge = {
      ...callbackBase,
      status: "completed",
      result: { passed: true, summary: "ok", output: "x".repeat(6145), truncated: false },
    };
    expect(
      (await handleDispatchV3Callback(await callbackRequest(tooLarge), settings, store)).status,
    ).toBe(400);
    const duplicate = `{"contract":"${callbackContract}","contract":"${callbackContract}","ownerId":"${scope.ownerId}","projectId":"${scope.projectId}","grantId":"${scope.grantId}","jobId":"${scope.jobId}","repo":"${scope.repo}","payloadDigest":"${scope.payloadDigest}","status":"quarantined"}`;
    expect(
      (
        await handleDispatchV3Callback(
          await callbackRequest({}, { raw: duplicate }),
          settings,
          store,
        )
      ).status,
    ).toBe(400);
    expect(store).not.toHaveBeenCalled();
  });

  it("uses the callback environment only when the feature flag is exactly true", async () => {
    vi.stubEnv("JACKBOY_DISPATCH_V3_ENABLED", "true");
    vi.stubEnv("OMNI_DISPATCH_CALLBACK_CLIENT_ID", clientId);
    vi.stubEnv("OMNI_DISPATCH_CALLBACK_SECRET", secret);
    const callback = { ...callbackBase, status: "quarantined" };
    const store = vi.fn().mockResolvedValue(undefined);
    expect(
      (await handleDispatchV3Callback(await callbackRequest(callback), undefined, store)).status,
    ).toBe(200);
    expect(store).toHaveBeenCalledTimes(1);
  });

  it("rejects callback envelopes larger than 8192 bytes and preserves UTF-8 byte bounds", async () => {
    const oversized = { ...callbackBase, status: "running", padding: "x".repeat(8200) };
    expect(
      (await handleDispatchV3Callback(await callbackRequest(oversized), settings, vi.fn())).status,
    ).toBe(400);
    const invalidSummary = {
      ...callbackBase,
      status: "completed",
      result: { passed: true, summary: "🙂".repeat(501), output: "", truncated: false },
    };
    expect(
      (await handleDispatchV3Callback(await callbackRequest(invalidSummary), settings, vi.fn()))
        .status,
    ).toBe(400);
  });
});

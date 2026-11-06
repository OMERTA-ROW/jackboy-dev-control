import { describe, expect, it, vi } from "vitest";
import { handleDispatchCallback } from "./omni-dispatch-callback.server";
import { hmacHex } from "./omni-link";

const contract = "jackboy.dispatch-callback/v2";
const path = "/api/public/omni/callback";
const settings = { clientId: "mothership", secret: "test-secret-0123456789-0123456789-0123456789" };
const payload = {
  contract,
  ownerId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  grantId: "33333333-3333-4333-8333-333333333333",
  jobId: "44444444-4444-4444-8444-444444444444",
  repo: "acme/repo",
  payloadDigest: "a".repeat(64),
  status: "quarantined",
};

async function request(data = payload, options: { secret?: string; timestamp?: string } = {}) {
  const raw = JSON.stringify(data);
  const timestamp = options.timestamp || String(Math.floor(Date.now() / 1000));
  const nonce = "b".repeat(32);
  const signature = await hmacHex(
    options.secret || settings.secret,
    `${contract}\nPOST\n${path}\n${settings.clientId}\n${timestamp}\n${nonce}\n${raw}`,
  );
  return new Request(`https://jackboy.example${path}`, {
    method: "POST",
    headers: {
      "x-omni-contract": contract,
      "x-omni-client": settings.clientId,
      "x-omni-timestamp": timestamp,
      "x-omni-nonce": nonce,
      "x-omni-signature": signature,
    },
    body: raw,
  });
}

describe("scoped dispatch callback", () => {
  it("authenticates, binds the payload, and signs the response", async () => {
    const store = vi.fn().mockResolvedValue(undefined);
    const response = await handleDispatchCallback(await request(), settings, store);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(store).toHaveBeenCalledWith("b".repeat(32), payload);
    expect(response.headers.get("x-omni-proof")).toBe(
      await hmacHex(settings.secret, `${contract}\nresponse\n${"b".repeat(32)}\n200\n${body}`),
    );
  });
  it("rejects bad credentials, expired signatures and unsupported states before persistence", async () => {
    const store = vi.fn();
    expect(
      (await handleDispatchCallback(await request(payload, { secret: "wrong" }), settings, store))
        .status,
    ).toBe(401);
    expect(
      (
        await handleDispatchCallback(
          await request(payload, { timestamp: "1000000000" }),
          settings,
          store,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleDispatchCallback(
          await request({ ...payload, status: "completed" }),
          settings,
          store,
        )
      ).status,
    ).toBe(400);
    expect(store).not.toHaveBeenCalled();
  });
  it("fails closed when disabled or persistence rejects, and refuses legacy requests", async () => {
    expect((await handleDispatchCallback(await request(), null)).status).toBe(503);
    expect(
      (
        await handleDispatchCallback(
          await request(),
          settings,
          vi.fn().mockRejectedValue(new Error()),
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await handleDispatchCallback(
          new Request(`https://jackboy.example${path}`, { method: "POST" }),
          settings,
        )
      ).status,
    ).toBe(410);
  });
});

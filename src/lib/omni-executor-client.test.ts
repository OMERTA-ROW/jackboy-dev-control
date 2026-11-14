import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { signedExecutorRequest } from "./omni-executor-client";

const secret = "synthetic-executor-secret-for-tests-only";
const origin = "https://executor-fixture.up.railway.app";
afterEach(() => vi.unstubAllGlobals());

function signedReply(status: number) {
  return vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const nonce = new Headers(init?.headers).get("X-Executor-Nonce");
    const body = JSON.stringify({ cancelled: true });
    const proof = createHmac("sha256", secret)
      .update(`omni.autonomous/v1\nresponse\n${nonce}\n${status}\n${body}`)
      .digest("hex");
    return new Response(body, { status, headers: { "X-Executor-Proof": proof } });
  });
}

it("accepts a verified successful executor response", async () => {
  vi.stubGlobal("fetch", signedReply(200));
  await expect(signedExecutorRequest(origin, secret, "cancel", {})).resolves.toEqual({
    cancelled: true,
  });
});

it("uses edge-safe manual redirects and refuses even a correctly signed redirect", async () => {
  const fetch = signedReply(302);
  vi.stubGlobal("fetch", fetch);
  await expect(signedExecutorRequest(origin, secret, "cancel", {})).rejects.toThrow(
    "Executor proof or status failed",
  );
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("manual");
});

it("refuses an unverified successful response", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response('{"cancelled":true}')),
  );
  await expect(signedExecutorRequest(origin, secret, "cancel", {})).rejects.toThrow(
    "Executor proof or status failed",
  );
});

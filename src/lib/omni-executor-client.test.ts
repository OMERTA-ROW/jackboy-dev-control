import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { signedExecutorRequest } from "./omni-executor-client";
import { executorRequest } from "./omni-execution.server";

const secret = "synthetic-executor-secret-for-tests-only";
const origin = "https://executor-fixture.up.railway.app";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

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

it.each([
  "http://omni-autonomous-executor.railway.internal:8080",
  "http://omni-autonomous-executor.railway.internal:8080/",
  origin,
])(
  "accepts the scoped executor origin %s with unchanged signed transport",
  async (executorOrigin) => {
    const fetch = signedReply(200);
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("OMNI_EXECUTOR_ORIGIN", executorOrigin);
    vi.stubEnv("OMNI_EXECUTOR_CONTROL_SECRET", secret);
    vi.stubEnv("OMNI_SANDBOX_ORIGIN", "");
    vi.stubEnv("OMNI_REMOTE_RUNNER_ORIGIN", "");
    await expect(executorRequest("cancel", {})).resolves.toEqual({ cancelled: true });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(`${executorOrigin.replace(/\/$/, "")}/omni-autonomous/v1`);
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Executor-Signature")).toBe(
      createHmac("sha256", secret)
        .update(
          `omni.autonomous/v1\n/omni-autonomous/v1\n${headers.get("X-Executor-Timestamp")}\n${headers.get("X-Executor-Nonce")}\n${init?.body}`,
        )
        .digest("hex"),
    );
    expect(init?.redirect).toBe("manual");
  },
);

it.each([
  "http://arbitrary.railway.internal:8080",
  "http://executor-fixture.up.railway.app:8080",
  "http://omni-autonomous-executor.railway.internal",
  "http://omni-autonomous-executor.railway.internal:8081",
  "http://omni-autonomous-executor.railway.internal:8080/path",
  "http://omni-autonomous-executor.railway.internal:8080/path/..",
  "http://omni-autonomous-executor.railway.internal:8080?query=1",
  "http://omni-autonomous-executor.railway.internal:8080#fragment",
  "http://user:password@omni-autonomous-executor.railway.internal:8080",
  "http://omni-autonomous-executor.railway.internal.evil:8080",
  "http://127.0.0.1:8080",
  "https://arbitrary.example",
])("rejects out-of-scope executor origin %s before transport", async (executorOrigin) => {
  const fetch = signedReply(200);
  vi.stubGlobal("fetch", fetch);
  vi.stubEnv("OMNI_EXECUTOR_ORIGIN", executorOrigin);
  vi.stubEnv("OMNI_EXECUTOR_CONTROL_SECRET", secret);
  await expect(executorRequest("inspect", {})).rejects.toThrow("Executor must use");
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["OMNI_SANDBOX_ORIGIN", "OMNI_REMOTE_RUNNER_ORIGIN"])(
  "rejects private executor sharing %s",
  async (legacySetting) => {
    const internalOrigin = "http://omni-autonomous-executor.railway.internal:8080";
    const fetch = signedReply(200);
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("OMNI_EXECUTOR_ORIGIN", internalOrigin);
    vi.stubEnv("OMNI_EXECUTOR_CONTROL_SECRET", secret);
    vi.stubEnv(legacySetting, internalOrigin);
    await expect(executorRequest("inspect", {})).rejects.toThrow("Executor must not share");
    expect(fetch).not.toHaveBeenCalled();
  },
);

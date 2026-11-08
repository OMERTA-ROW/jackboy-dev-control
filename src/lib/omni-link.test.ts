import { describe, expect, it } from "vitest";
import {
  dispatchBackoffMs,
  hmacHex,
  nextStatus,
  omniConfigurationFingerprint,
  omniEndpointFingerprint,
  parseHandshake,
  parseResult,
  safeOmniCallbackOrigin,
  safeOmniDiagnostic,
  safeOmniPullRequestUrl,
  signedString,
  verifyCallback,
} from "./omni-link";

const SECRET = "test-secret";
// Same vector is asserted in OMNI's Go tests (inbox/internal/inbox/sign_test.go).
const VECTOR = "8797526ca23119cd7fe313d6c824069756534bdb50782ea449d7cf62f1374d91";

describe("omni link", () => {
  it("accepts a fresh correctly signed callback and refuses tampering, staleness and missing headers", async () => {
    const body = '{"a":1}', ts = "1793600000", nonce = "nonce-abcdefghijklmnop";
    const sig = `sha256=${await hmacHex(SECRET, signedString(ts, nonce, body))}`;
    const now = 1793600000 * 1000;
    expect(await verifyCallback(SECRET, { signature: sig, timestamp: ts, nonce }, body, now)).toBeNull();
    expect(await verifyCallback(SECRET, { signature: sig, timestamp: ts, nonce }, '{"a":2}', now)).toBe("signature mismatch");
    expect(await verifyCallback(SECRET, { signature: sig, timestamp: ts, nonce }, body, now + 6 * 60_000)).toBe("stale or invalid timestamp");
    expect(await verifyCallback(SECRET, { signature: null, timestamp: ts, nonce }, body, now)).toBe("missing signature headers");
  });
  it("matches the shared HMAC vector used by OMNI", async () => {
    expect(await hmacHex(SECRET, "jackboy-omni-vector")).toBe(VECTOR);
  });
  it("fingerprints only the non-secret OMNI endpoint configuration", async () => {
    const fingerprint = await omniEndpointFingerprint("https://omni.example");
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).toBe(await omniEndpointFingerprint("https://omni.example"));
    expect(fingerprint).not.toBe(await omniEndpointFingerprint("https://other.example"));
  });
  it("binds live verification to endpoint, credentials and callback without returning secret values", async () => {
    const fingerprint = await omniConfigurationFingerprint(
      "https://omni.example",
      "api-key-one",
      "callback-secret-one",
      "https://jackboy.example/callback",
    );
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain("api-key-one");
    expect(fingerprint).not.toContain("callback-secret-one");
    expect(fingerprint).not.toBe(await omniConfigurationFingerprint(
      "https://omni.example",
      "api-key-two",
      "callback-secret-one",
      "https://jackboy.example/callback",
    ));
    expect(fingerprint).not.toBe(await omniConfigurationFingerprint(
      "https://omni.example",
      "api-key-one",
      "callback-secret-two",
      "https://jackboy.example/callback",
    ));
  });
  it("backs off exponentially up to six hours", () => {
    expect(dispatchBackoffMs(1)).toBe(60_000);
    expect(dispatchBackoffMs(3)).toBe(240_000);
    expect(dispatchBackoffMs(20)).toBe(6 * 3600_000);
  });
  it("rejects handshakes without the contract or proof", () => {
    expect(parseHandshake({ contract: "x" })).toBeTypeOf("string");
    expect(parseHandshake({ contract: "omni.handshake/v1", version: "0.1.0", capabilities: ["jobs"] })).toBeTypeOf("string");
    expect(parseHandshake({ contract: "omni.handshake/v1", version: "0.1.0", capabilities: ["jobs"], proof: "ab" })).toMatchObject({ version: "0.1.0" });
  });
  it("withholds untrusted remote error details while preserving safe HTTP diagnostics", () => {
    expect(safeOmniDiagnostic("OMNI answered HTTP 503: api_key=private-value")).toBe("OMNI answered HTTP 503. Response details withheld.");
    expect(safeOmniDiagnostic("Missing secrets: OMNI_API_URL, OMNI_CALLBACK_SECRET")).toBe("Missing secrets: OMNI_API_URL, OMNI_CALLBACK_SECRET");
    expect(safeOmniDiagnostic("Bearer secret-token-value")).toBe("OMNI reported an error; response details withheld.");
  });
  it("only exposes exact GitHub pull-request URLs from OMNI results", () => {
    expect(safeOmniPullRequestUrl("https://github.com/acme/repo/pull/42")).toBe("https://github.com/acme/repo/pull/42");
    expect(safeOmniPullRequestUrl("https://evil.example/")).toBeNull();
    expect(safeOmniPullRequestUrl("https://github.com/acme/repo/pull/42?next=https://evil.example")).toBeNull();
    expect(safeOmniPullRequestUrl(null)).toBeNull();
  });
  it("only exposes the HTTPS callback origin, never URL credentials or paths", () => {
    expect(safeOmniCallbackOrigin("https://jackboy.example/api/callback?token=private")).toBe("https://jackboy.example");
    expect(safeOmniCallbackOrigin("https://user:password@jackboy.example/callback")).toBeNull();
    expect(safeOmniCallbackOrigin("http://jackboy.example/callback")).toBeNull();
    expect(safeOmniCallbackOrigin("not a URL")).toBeNull();
  });
  it("accepts only GitHub pull request links in results and never reopens finished jobs", () => {
    const r = parseResult({ contract: "omni.job-result/v1", jobId: "11111111-1111-1111-1111-111111111111", status: "completed", prUrl: "https://evil.example/pull/1" });
    expect(typeof r === "string" ? r : r.prUrl).toBeNull();
    expect(nextStatus("completed", "running")).toBeNull();
    expect(nextStatus("queued", "completed")).toBeNull();
    expect(nextStatus("sent", "failed")).toBe("failed");
  });
});

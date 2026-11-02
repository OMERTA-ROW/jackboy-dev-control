import { describe, expect, it } from "vitest";
import { dispatchBackoffMs, hmacHex, nextStatus, parseHandshake, parseResult, signedString, verifyCallback } from "./omni-link";

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
  it("accepts only GitHub pull request links in results and never reopens finished jobs", () => {
    const r = parseResult({ contract: "omni.job-result/v1", jobId: "11111111-1111-1111-1111-111111111111", status: "completed", prUrl: "https://evil.example/pull/1" });
    expect(typeof r === "string" ? r : r.prUrl).toBeNull();
    expect(nextStatus("completed", "running")).toBeNull();
    expect(nextStatus("queued", "completed")).toBeNull();
    expect(nextStatus("sent", "failed")).toBe("failed");
  });
});

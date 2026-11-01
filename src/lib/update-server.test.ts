import { describe, expect, it } from "vitest";
import { canonicalJson, compareVersions, nextRolloutPercent, pickRelease, rolloutBucket, shouldRollback, signingKeys, signPayload, verifyPayload } from "./update-server";

describe("update server rules", () => {
  it("orders semantic versions", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("2.0.0-beta.1", "2.0.0")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });
  it("0% rollout serves nobody new, 100% serves everyone", () => {
    const rel = [{ id: "a", version: "1.0.0", status: "complete" as const, rollout_percent: 100 }, { id: "b", version: "1.1.0", status: "rolling" as const, rollout_percent: 0 }];
    expect(pickRelease(rel, "dev1")?.version).toBe("1.0.0");
    rel[1]!.rollout_percent = 100;
    expect(pickRelease(rel, "dev1")?.version).toBe("1.1.0");
  });
  it("rolled back and paused releases are never served", () => {
    const rel = [{ id: "a", version: "1.0.0", status: "complete" as const, rollout_percent: 100 }, { id: "b", version: "1.1.0", status: "rolled_back" as const, rollout_percent: 100 }, { id: "c", version: "1.2.0", status: "paused" as const, rollout_percent: 100 }];
    expect(pickRelease(rel, "x")?.version).toBe("1.0.0");
  });
  it("buckets are stable", () => {
    expect(rolloutBucket("d", "r")).toBe(rolloutBucket("d", "r"));
    expect(rolloutBucket("d", "r")).toBeLessThan(100);
  });
  it("rolls back only at or above threshold with enough reports", () => {
    expect(shouldRollback({ total: 19, failures: 19 }, 5, 20)).toBe(false);
    expect(shouldRollback({ total: 20, failures: 1 }, 5, 20)).toBe(true);
    expect(shouldRollback({ total: 100, failures: 4 }, 5, 20)).toBe(false);
  });
  it("rollout steps cap at 100", () => expect(nextRolloutPercent(90, 25)).toBe(100));
  it("signatures verify and detect tampering", async () => {
    const k = await signingKeys("test-secret");
    const m = { b: 1, a: "x" };
    const { signature } = await signPayload(k.privateKey, m);
    expect(await verifyPayload(k.publicKeyBase64, { a: "x", b: 1 }, signature)).toBe(true);
    expect(await verifyPayload(k.publicKeyBase64, { a: "y", b: 1 }, signature)).toBe(false);
    expect(canonicalJson(m)).toBe('{"a":"x","b":1}');
  });
});

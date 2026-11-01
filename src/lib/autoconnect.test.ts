import { describe, expect, it } from "vitest";
import { afterApproval, afterVerify, bucket, canVerify, capabilityForTestGap, capById, effectiveStatus } from "./autoconnect";

describe("autoconnect security rules", () => {
  it("approval alone never grants access", () => {
    expect(afterApproval(capById("github_actions_read")!)).toBe("awaiting_setup");
    expect(afterApproval(capById("browser_runner")!)).toBe("unavailable");
  });
  it("only a passing, unexpired verification connects", () => {
    expect(afterVerify(false, null)).toBe("error");
    expect(afterVerify(true, null)).toBe("connected");
    expect(afterVerify(true, "2000-01-01T00:00:00Z")).toBe("expired");
  });
  it("connected grants expire", () => {
    expect(effectiveStatus({ status: "connected", expires_at: "2000-01-01T00:00:00Z" })).toBe("expired");
  });
  it("blocks verification when paused, revoked, unapproved or over the retry limit", () => {
    const g = { paused: false, verify_attempts: 0, status: "awaiting_setup" as const };
    expect(canVerify(g)).toBeNull();
    expect(canVerify({ ...g, paused: true })).not.toBeNull();
    expect(canVerify({ ...g, status: "revoked" })).not.toBeNull();
    expect(canVerify({ ...g, status: "needs_approval" })).not.toBeNull();
    expect(canVerify({ ...g, verify_attempts: 10 })).not.toBeNull();
  });
  it("buckets statuses and maps test gaps", () => {
    expect(bucket("connected")).toBe("Connected");
    expect(bucket("needs_approval")).toBe("Needs Approval");
    expect(bucket("expired")).toBe("Missing/Blocked");
    expect(capabilityForTestGap('GitHub 403 ... needs "Actions: read" permission')).toBe("github_actions_read");
  });
});

import { describe, expect, it } from "vitest";
import { canApprove, canExecute, canTransition, classifyRisk, nextProject, quotaLeft } from "./foundry";

describe("foundry state machine", () => {
  it("follows the happy path", () => {
    const path = ["discovered", "analyzing", "patch_prepared", "testing", "awaiting_approval", "approved", "executing", "verifying", "completed"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });
  it("cannot skip approval", () => {
    expect(canTransition("testing", "executing")).toBe(false);
    expect(canTransition("awaiting_approval", "executing")).toBe(false);
  });
  it("completed is terminal", () => expect(canTransition("completed", "analyzing")).toBe(false));
});

describe("approval gates", () => {
  const base = { state: "approved" as const, approved_action: "open_draft_pr", paused: false, attempts: 0, max_attempts: 3 };
  it("executes only one approved action", () => {
    expect(canExecute(base)).toBeNull();
    expect(canExecute({ ...base, approved_action: "merge" })).not.toBeNull();
  });
  it("blocks when paused or out of retries", () => {
    expect(canExecute({ ...base, paused: true })).not.toBeNull();
    expect(canExecute({ ...base, attempts: 3 })).not.toBeNull();
  });
  it("needs branch and test evidence to approve", () => {
    expect(canApprove({ state: "awaiting_approval", branch: null, test_evidence: { status: "x" } })).not.toBeNull();
    expect(canApprove({ state: "awaiting_approval", branch: "jackboy/a", test_evidence: {} })).not.toBeNull();
    expect(canApprove({ state: "awaiting_approval", branch: "jackboy/a", test_evidence: { status: "not_runnable" } })).toBeNull();
  });
  it("marks auth/payment/secret/deletion changes sensitive", () => {
    expect(classifyRisk([{ path: "src/lib/auth.ts" }])).toBe("sensitive");
    expect(classifyRisk([{ path: "src/lib/billing/x.ts" }])).toBe("sensitive");
    expect(classifyRisk([{ path: "README.md", deleted: true }])).toBe("sensitive");
    expect(classifyRisk([{ path: "README.md" }])).toBe("low");
  });
});

describe("scheduling", () => {
  it("rotates projects", () => {
    const p = [{ id: "a" }, { id: "b" }];
    expect(nextProject(p, null)?.id).toBe("a");
    expect(nextProject(p, "a")?.id).toBe("b");
    expect(nextProject(p, "b")?.id).toBe("a");
  });
  it("bounds daily quota", () => {
    expect(quotaLeft(3, 5)).toBe(0);
    expect(quotaLeft(3, 1)).toBe(2);
  });
});

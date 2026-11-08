import { describe, expect, it } from "vitest";
import { MAX_REVERT_FILES, revertClashes, revertNextStep, revertPlan, undoBlockReason, undoKind, undoNeedsPasskey } from "./code-undo";

describe("CODE undo", () => {
  it("closes a draft without a passkey; reverting a merged change needs one", () => {
    expect(undoKind({ state: "open", merged: false, draft: true })).toBe("close_draft");
    expect(undoKind({ state: "closed", merged: true, draft: false })).toBe("revert_merged");
    expect(undoKind({ state: "closed", merged: false, draft: true })).toBeNull();
    expect(undoNeedsPasskey("close_draft")).toBe(false);
    expect(undoNeedsPasskey("revert_merged")).toBe(true);
  });
  it("is blocked while the Kill Switch is on, off the allowed list, or already done", () => {
    const ok = { kind: "close_draft" as const, killSwitch: false, repoAllowed: true, existing: null };
    expect(undoBlockReason(ok)).toBeNull();
    expect(undoBlockReason({ ...ok, killSwitch: true })).toMatch(/Kill Switch is on/);
    expect(undoBlockReason({ ...ok, killSwitch: null })).toMatch(/can't be read/);
    expect(undoBlockReason({ ...ok, repoAllowed: false })).toMatch(/allowed list/);
    expect(undoBlockReason({ ...ok, existing: { status: "done" } })).toMatch(/already undone/);
    expect(undoBlockReason({ ...ok, existing: { status: "waiting_checks" } })).toMatch(/in progress/);
    expect(undoBlockReason({ ...ok, existing: { status: "failed" } })).toBeNull();
  });
  it("refuses when newer work changed the same files", () => {
    expect(revertClashes([
      { path: "a.ts", afterMerge: "s1", onMainNow: "s1" },
      { path: "b.ts", afterMerge: "s2", onMainNow: "s9" },
      { path: "new.ts", afterMerge: "s3", onMainNow: null },
    ])).toEqual(["b.ts", "new.ts"]);
  });
  it("restores modified/removed files and deletes added ones", () => {
    const p = revertPlan([
      { filename: "a.ts", status: "modified" },
      { filename: "b.ts", status: "added" },
      { filename: "c.ts", status: "removed" },
      { filename: "d2.ts", status: "renamed", previous_filename: "d.ts" },
    ]);
    expect(p.error).toBeNull();
    expect(p.restore.sort()).toEqual(["a.ts", "c.ts", "d.ts"]);
    expect(p.remove.sort()).toEqual(["b.ts", "d2.ts"]);
    expect(revertPlan(Array.from({ length: MAX_REVERT_FILES + 1 }, (_, i) => ({ filename: `f${i}`, status: "modified" }))).error).toMatch(/up to 40/);
  });
  it("merges its own revert only after checks pass", () => {
    const t = Date.parse("2026-11-07T12:00:00Z");
    expect(revertNextStep("success", t, t)).toBe("merge");
    expect(revertNextStep("pending", t, t + 60 * 60_000)).toBe("wait");
    expect(revertNextStep("failure", t, t)).toBe("fail_checks");
    expect(revertNextStep("none", t, t + 10 * 60_000)).toBe("wait");
    expect(revertNextStep("none", t, t + 31 * 60_000)).toBe("fail_no_checks");
  });
});

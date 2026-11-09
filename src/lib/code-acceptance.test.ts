import { describe, expect, it } from "vitest";
import { acceptanceBlockReason, acceptanceFilesCheck, acceptanceInstruction, ACCEPTANCE_FILE } from "./code-acceptance";
import { FRESH_ONLY_ACTIONS, mayRequest, recentEligible } from "./step-up";

const ok = { enabled: true, killSwitch: false, globalPaused: false, activeRequestId: null, perTaskReserveUsd: 1, allowed: true };

describe("CODE acceptance test", () => {
  it("starts only when every gate passes", () => {
    expect(acceptanceBlockReason(ok)).toBeNull();
    expect(acceptanceBlockReason({ ...ok, enabled: false })).toMatch(/off/);
    expect(acceptanceBlockReason({ ...ok, killSwitch: true })).toMatch(/emergency stop/);
    expect(acceptanceBlockReason({ ...ok, globalPaused: null })).toMatch(/Kill Switch/);
    expect(acceptanceBlockReason({ ...ok, activeRequestId: "x" })).toMatch(/active/);
    expect(acceptanceBlockReason({ ...ok, allowed: false })).toMatch(/allow list/);
  });
  it("refuses a hold above $1", () => {
    expect(acceptanceBlockReason({ ...ok, perTaskReserveUsd: 1.01 })).toMatch(/\$1/);
    expect(acceptanceBlockReason({ ...ok, perTaskReserveUsd: null })).not.toBeNull();
  });
  it("uses a fixed docs-only instruction", () => {
    const text = acceptanceInstruction(new Date("2026-11-09T12:00:00Z"));
    expect(text).toContain("Acceptance test 2026-11-09");
    expect(text).toContain(ACCEPTANCE_FILE);
    expect(text).toContain("Change no other file");
  });
  it("accepts only the one acceptance file", () => {
    expect(acceptanceFilesCheck([{ filename: ACCEPTANCE_FILE, status: "added", deletions: 0 }]).ok).toBe(true);
    expect(acceptanceFilesCheck([{ filename: ACCEPTANCE_FILE, status: "modified", deletions: 0 }, { filename: "src/x.ts", status: "modified", deletions: 0 }]).ok).toBe(false);
    expect(acceptanceFilesCheck([{ filename: ACCEPTANCE_FILE, status: "modified", deletions: 2 }]).ok).toBe(false);
    expect(acceptanceFilesCheck([]).ok).toBe(false);
  });
  it("needs a fresh owner passkey every time", () => {
    expect(mayRequest("code_acceptance_test", "owner").ok).toBe(true);
    expect(mayRequest("code_acceptance_test", "admin").ok).toBe(false);
    expect(FRESH_ONLY_ACTIONS).toContain("code_acceptance_test");
    expect(recentEligible("code_acceptance_test", "code_acceptance:a/b")).toBe(false);
  });
});

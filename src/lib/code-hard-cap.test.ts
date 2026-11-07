import { describe, expect, it } from "vitest";
import { HARD_CAP_TARGET, hardCapChangeBlockReason, type HardCapChangeInput } from "./code-safety";
import { FRESH_ONLY_ACTIONS, grantIsFresh, mayRequest, recentEligible } from "./step-up";

const stopped: HardCapChangeInput["current"] = {
  enabled: false,
  killSwitch: true,
  activeRequestId: null,
  activeRunId: null,
  providerBudgetEnforced: false,
  totalSpendGuard: { enforced: true, limitUsd: 10, committedUsd: 0 },
};
const note = "Checked OpenAI project budget page on Nov 7";
const mark = (current: Partial<HardCapChangeInput["current"]> = {}, evidence = note) =>
  hardCapChangeBlockReason({ verified: true, evidence, current: { ...stopped, ...current } });
const unmark = (current: Partial<HardCapChangeInput["current"]> = {}, evidence = note) =>
  hardCapChangeBlockReason({ verified: false, evidence, current: { ...stopped, providerBudgetEnforced: true, ...current } });

describe("owner hard-cap attestation rules", () => {
  it("allows marking only while CODE is off, Emergency Stop is on, no task runs and the $10 guard is active", () => {
    expect(mark()).toBeNull();
    expect(mark({ enabled: true })).toMatch(/CODE off/);
    expect(mark({ killSwitch: false })).toMatch(/Emergency Stop on/);
    expect(mark({ activeRequestId: "r1" })).toMatch(/no CODE task/);
    expect(mark({ activeRunId: 42 })).toMatch(/no CODE task/);
  });

  it("refuses marking without an enforced $10 guard or once the $10 is used up", () => {
    expect(mark({ totalSpendGuard: null })).toMatch(/\$10 total spending guard/);
    expect(mark({ totalSpendGuard: { enforced: false, limitUsd: 10, committedUsd: 0 } })).toMatch(/\$10 total/);
    expect(mark({ totalSpendGuard: { enforced: true, limitUsd: 10.01, committedUsd: 0 } })).toMatch(/invalid/);
    expect(mark({ totalSpendGuard: { enforced: true, limitUsd: 10, committedUsd: 10 } })).toMatch(/used up/);
    expect(mark({ totalSpendGuard: { enforced: true, limitUsd: 10, committedUsd: 9.99 } })).toBeNull();
  });

  it("allows un-marking under the same stopped conditions, even without the guard", () => {
    expect(unmark()).toBeNull();
    expect(unmark({ totalSpendGuard: null })).toBeNull();
    expect(unmark({ enabled: true })).toMatch(/CODE off/);
    expect(unmark({ killSwitch: false })).toMatch(/Emergency Stop on/);
  });

  it("needs an evidence note of 10 to 500 characters", () => {
    expect(mark({}, "too short")).toMatch(/evidence note/);
    expect(mark({}, "          padded   ")).toMatch(/evidence note/);
    expect(mark({}, "x".repeat(501))).toMatch(/evidence note/);
    expect(mark({}, "x".repeat(10))).toBeNull();
  });

  it("refuses a no-op change", () => {
    expect(mark({ providerBudgetEnforced: true })).toMatch(/already marked/);
    expect(unmark({ providerBudgetEnforced: false })).toMatch(/already unverified/);
  });

  it("binds each passkey grant to one direction", () => {
    expect(HARD_CAP_TARGET.mark).not.toBe(HARD_CAP_TARGET.unmark);
  });
});

describe("hard-cap passkey freshness", () => {
  it("is owner-only", () => {
    expect(mayRequest("code_hard_cap", "owner").ok).toBe(true);
    expect(mayRequest("code_hard_cap", "admin").ok).toBe(false);
    expect(mayRequest("code_hard_cap", "member").ok).toBe(false);
  });

  it("never reuses a recent passkey check", () => {
    expect(FRESH_ONLY_ACTIONS).toContain("code_hard_cap");
    expect(recentEligible("code_hard_cap", HARD_CAP_TARGET.mark)).toBe(false);
    expect(recentEligible("code_hard_cap", HARD_CAP_TARGET.unmark)).toBe(false);
  });

  it("treats grants minted from a recent check as not fresh", () => {
    expect(grantIsFresh({ credential_id: "cred-abc" })).toBe(true);
    expect(grantIsFresh({ credential_id: "recent:cred-abc" })).toBe(false);
    expect(grantIsFresh({ credential_id: "" })).toBe(false);
    expect(grantIsFresh({ credential_id: null })).toBe(false);
    expect(grantIsFresh(null)).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { signupErrorMessage, mfaChallengeRequired, cooldownRemaining, passwordProblem } from "./account-auth";

describe("account auth UX rules", () => {
  it("explains closed registration instead of raw error", () => {
    expect(signupErrorMessage({ message: "Signups not allowed for this instance" })).toMatch(/invitation-only/);
  });
  it("maps rate limits", () => {
    expect(signupErrorMessage({ message: "x", code: "over_email_send_rate_limit" })).toMatch(/Too many/);
  });
  it("requires TOTP challenge only when a verified factor exists and session is aal1", () => {
    expect(mfaChallengeRequired({ currentLevel: "aal1", nextLevel: "aal2" })).toBe(true);
    expect(mfaChallengeRequired({ currentLevel: "aal2", nextLevel: "aal2" })).toBe(false);
    expect(mfaChallengeRequired({ currentLevel: "aal1", nextLevel: "aal1" })).toBe(false);
  });
  it("enforces 60s email cooldown", () => {
    expect(cooldownRemaining(1000, 31_000)).toBe(30);
    expect(cooldownRemaining(1000, 61_000)).toBe(0);
  });
  it("requires 10+ char matching passwords", () => {
    expect(passwordProblem("short")).toMatch(/10/);
    expect(passwordProblem("longenough1", "different11")).toMatch(/match/);
    expect(passwordProblem("longenough1", "longenough1")).toBeNull();
  });
});

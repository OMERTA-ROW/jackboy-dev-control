import { describe, expect, it } from "vitest";
import { decideRole, decideUser, gateCacheValid, GATE_CACHE_MS } from "./auth-gate";

describe("private-page gate", () => {
  it("a dropped connection while checking sign-in asks to retry instead of signing out", () => {
    expect(decideUser({ user: null, error: { name: "AuthRetryableFetchError", status: 0, message: "Failed to fetch" } })).toEqual({ kind: "retry", reason: "auth_unreachable" });
    expect(decideUser({ user: null, error: { status: 503, message: "unavailable" } })?.kind).toBe("retry");
    expect(decideUser({ user: null, error: { message: "TypeError: Failed to fetch" } })?.kind).toBe("retry");
  });
  it("a missing or rejected session still goes to sign-in", () => {
    expect(decideUser({ user: null, error: { name: "AuthSessionMissingError", status: 400 } })).toEqual({ kind: "signin" });
    expect(decideUser({ user: null, error: { name: "AuthApiError", status: 403, message: "invalid JWT" } })).toEqual({ kind: "signin" });
    expect(decideUser({ user: null, error: null })).toEqual({ kind: "signin" });
  });
  it("a signed-in user continues to the role check", () => {
    expect(decideUser({ user: { id: "u" }, error: null })).toBeNull();
  });
  it("a failed role check never means 'no access'", () => {
    expect(decideRole({ role: null, error: { message: "TypeError: Failed to fetch" } })).toEqual({ kind: "retry", reason: "role_unreachable" });
  });
  it("only a clean empty role answer sends to account setup", () => {
    expect(decideRole({ role: null, error: null })).toEqual({ kind: "onboarding" });
    expect(decideRole({ role: "superuser", error: null })).toEqual({ kind: "onboarding" });
    expect(decideRole({ role: "owner", error: null })).toEqual({ kind: "ok", role: "owner" });
  });
  it("reuses a confirmed check only for the same session and for 30 seconds", () => {
    const c = { token: "t1", at: 1000 };
    expect(gateCacheValid(c, "t1", 1000 + GATE_CACHE_MS - 1)).toBe(true);
    expect(gateCacheValid(c, "t1", 1000 + GATE_CACHE_MS)).toBe(false);
    expect(gateCacheValid(c, "t2", 1500)).toBe(false);
    expect(gateCacheValid(c, null, 1500)).toBe(false);
    expect(gateCacheValid(null, "t1", 1500)).toBe(false);
  });
});

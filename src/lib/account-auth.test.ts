import { describe, expect, it, vi } from "vitest";
import { OWNER_SETUP_REQUIRED, ownerSetupEligible, sendVerificationEmail, signInVerified } from "./account-auth";

describe("Owner identity and verified sign-in", () => {
  it("missing OWNER_EMAIL blocks bootstrap before email sending", () => {
    expect(() => ownerSetupEligible(undefined, "owner@example.test", false)).toThrow(OWNER_SETUP_REQUIRED);
  });
  it("only the configured identity can request setup while no owner exists", () => {
    expect(ownerSetupEligible("Owner@example.test", "owner@example.test", false)).toBe(true);
    expect(ownerSetupEligible("owner@example.test", "other@example.test", false)).toBe(false);
    expect(ownerSetupEligible("owner@example.test", "owner@example.test", true)).toBe(false);
  });
  it("owner password sign-in requires a revalidated confirmed identity", async () => {
    const auth = { signInWithPassword: vi.fn().mockResolvedValue({ error: null }), getUser: vi.fn().mockResolvedValue({ data: { user: { email_confirmed_at: "2026-11-01T04:38:00Z" } }, error: null }), signOut: vi.fn() };
    await expect(signInVerified(auth, "owner@example.test", "test-input-only")).resolves.toBeUndefined();
    expect(auth.getUser).toHaveBeenCalledOnce();
    expect(auth.signOut).not.toHaveBeenCalled();
  });
  it("unconfirmed sign-in is cleared instead of granting owner access", async () => {
    const auth = { signInWithPassword: vi.fn().mockResolvedValue({ error: null }), getUser: vi.fn().mockResolvedValue({ data: { user: { email_confirmed_at: null } }, error: null }), signOut: vi.fn() };
    await expect(signInVerified(auth, "owner@example.test", "test-input-only")).rejects.toThrow("Confirm your email");
    expect(auth.signOut).toHaveBeenCalledOnce();
  });
  it("failed password sign-in never advances to identity verification", async () => {
    const auth = { signInWithPassword: vi.fn().mockResolvedValue({ error: { message: "Invalid login credentials" } }), getUser: vi.fn(), signOut: vi.fn() };
    await expect(signInVerified(auth, "owner@example.test", "test-input-only")).rejects.toThrow("Invalid login credentials");
    expect(auth.getUser).not.toHaveBeenCalled();
  });
});

describe("Configured authentication mail sender", () => {
  it("missing email provider never resolves as email success", async () => {
    const auth = { admin: { inviteUserByEmail: vi.fn().mockResolvedValue({ error: { message: "Email is not configured on the server yet", code: "email_provider_disabled" } }) }, resetPasswordForEmail: vi.fn() };
    await expect(sendVerificationEmail(auth, "owner@example.test", "https://example.test/set-password")).rejects.toThrow("Email delivery is unavailable");
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });
  it("existing-account recovery delivery failures are not swallowed", async () => {
    const auth = { admin: { inviteUserByEmail: vi.fn().mockResolvedValue({ error: { message: "User already registered", code: "email_exists" } }) }, resetPasswordForEmail: vi.fn().mockResolvedValue({ error: { message: "Error sending recovery email" } }) };
    await expect(sendVerificationEmail(auth, "owner@example.test", "https://example.test/set-password")).rejects.toThrow("Email delivery is unavailable");
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith("owner@example.test", { redirectTo: "https://example.test/set-password" });
  });
  it("successful delivery request uses only the configured sender and verification callback", async () => {
    const auth = { admin: { inviteUserByEmail: vi.fn().mockResolvedValue({ error: null }) }, resetPasswordForEmail: vi.fn() };
    await sendVerificationEmail(auth, "owner@example.test", "https://example.test/set-password");
    expect(auth.admin.inviteUserByEmail).toHaveBeenCalledWith("owner@example.test", { redirectTo: "https://example.test/set-password" });
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled();
  });
});
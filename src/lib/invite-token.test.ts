import { describe, expect, it } from "vitest";
import { hashToken, inviteRedeemable, isWellFormedToken, newInviteToken } from "./invite-token";

const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 1000).toISOString();

describe("invitation tokens", () => {
  it("are 256-bit random hex and stored only as a hash", async () => {
    const t = newInviteToken();
    expect(isWellFormedToken(t)).toBe(true);
    expect(newInviteToken()).not.toBe(t);
    const h = await hashToken(t);
    expect(h).not.toBe(t);
    expect(await hashToken(t)).toBe(h);
  });
  it("can be redeemed only once, while pending and unexpired", () => {
    expect(inviteRedeemable({ status: "pending", expires_at: future, used_at: null }).ok).toBe(true);
    expect(inviteRedeemable({ status: "accepted", expires_at: future, used_at: future }).ok).toBe(false);
    expect(inviteRedeemable({ status: "pending", expires_at: future, used_at: past }).ok).toBe(false);
    expect(inviteRedeemable({ status: "revoked", expires_at: future, used_at: null }).ok).toBe(false);
    expect(inviteRedeemable({ status: "pending", expires_at: past, used_at: null }).ok).toBe(false);
    expect(inviteRedeemable(null).ok).toBe(false);
  });
  it("rejects malformed tokens", () => {
    expect(isWellFormedToken("abc")).toBe(false);
    expect(isWellFormedToken(undefined)).toBe(false);
  });
});

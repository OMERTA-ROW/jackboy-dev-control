import { describe, it, expect } from "vitest";
import { newRecoveryCodes, normalizeRecoveryCode, hashRecoveryCode, recoveryRateLimited, canGenerateCodes } from "./recovery-codes";

describe("recovery codes", () => {
  it("issues 10 unique well-formed codes", () => {
    const c = newRecoveryCodes();
    expect(c).toHaveLength(10);
    expect(new Set(c).size).toBe(10);
    c.forEach((x) => expect(normalizeRecoveryCode(x)).not.toBeNull());
  });
  it("accepts lowercase/spaces, rejects junk", () => {
    expect(normalizeRecoveryCode("abcde fghjk")).toBe("ABCDEFGHJK");
    expect(normalizeRecoveryCode("12345")).toBeNull();
    expect(normalizeRecoveryCode("'; drop--x")).toBeNull();
  });
  it("hash is per-user and never equals the code", async () => {
    const a = await hashRecoveryCode("u1", "ABCDE-FGHJK");
    expect(a).toBe(await hashRecoveryCode("u1", "abcdefghjk"));
    expect(a).not.toBe(await hashRecoveryCode("u2", "ABCDE-FGHJK"));
    expect(a).not.toContain("ABCDE");
  });
  it("locks after 5 failures", () => {
    expect(recoveryRateLimited(4)).toBe(false);
    expect(recoveryRateLimited(5)).toBe(true);
  });
  it("only aal2 sessions can generate codes", () => {
    expect(canGenerateCodes("aal1")).toBe(false);
    expect(canGenerateCodes("aal2")).toBe(true);
  });
});

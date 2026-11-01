import { describe, expect, it } from "vitest";
import { deliveryBackoffMs, licenseAllowed, redact, scorePattern, toCsv } from "./site-log";

describe("site log safety", () => {
  it("redacts tokens, keys, JWTs and emails", () => {
    const out = redact("token ghp_abcdefghijklmnopqrstuvwxyz123456 Bearer abcdefghijklmnop mail me@x.com sb_secret_abcdefghijklmnop");
    expect(out).not.toMatch(/ghp_|me@x\.com|sb_secret_abc|Bearer abcdef/);
  });
  it("allows only permissive licenses for reuse", () => {
    expect(licenseAllowed("MIT")).toBe(true);
    expect(licenseAllowed("GPL-3.0")).toBe(false);
    expect(licenseAllowed(null)).toBe(false);
  });
  it("scores archived repos zero and unlicensed lower", () => {
    const base = { licenseOk: true, archived: false, daysSincePush: 30, stars: 10, pathMatches: true };
    expect(scorePattern({ ...base, archived: true })).toBe(0);
    expect(scorePattern({ ...base, licenseOk: false })).toBeLessThan(scorePattern(base));
  });
  it("backs off deliveries and caps at 12h", () => {
    expect(deliveryBackoffMs(1)).toBe(60_000);
    expect(deliveryBackoffMs(20)).toBe(43_200_000);
  });
  it("escapes CSV", () => expect(toCsv([{ a: 'x,"y"' }], ["a"])).toBe('a\n"x,""y"""'));
});

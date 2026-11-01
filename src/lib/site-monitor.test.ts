import { describe, it, expect } from "vitest";
import { classify, nextCheckDelay, validateSiteUrl } from "./site-monitor";

const dns = { ok: true, addresses: ["1.2.3.4"] };
describe("site monitor", () => {
  it("adds https to bare domains", () => expect(validateSiteUrl("example.com")).toMatchObject({ ok: true, host: "example.com" }));
  it("refuses http and private hosts", () => {
    expect(validateSiteUrl("http://example.com").ok).toBe(false);
    expect(validateSiteUrl("https://localhost").ok).toBe(false);
    expect(validateSiteUrl("https://10.0.0.1").ok).toBe(false);
  });
  it("unresolved DNS is unreachable", () => expect(classify({ dns: { ok: false, addresses: [] } }).status).toBe("unreachable"));
  it("200 is connected but says it is not coding access", () => {
    const c = classify({ dns, http: { status: 200, ms: 50, finalUrl: "x" } });
    expect(c.status).toBe("connected");
    expect(c.reason).toMatch(/coding access is checked separately/);
  });
  it("401/403 means authorization needed", () => expect(classify({ dns, http: { status: 403, ms: 1, finalUrl: "x" } }).status).toBe("auth_needed"));
  it("5xx and timeouts are unreachable", () => {
    expect(classify({ dns, http: { status: 503, ms: 1, finalUrl: "x" } }).status).toBe("unreachable");
    expect(classify({ dns, http: { error: "HTTPS request timed out after 10 s.", ms: 1 } }).status).toBe("unreachable");
  });
  it("backs off on failures, capped at 12 h", () => {
    expect(nextCheckDelay("unreachable", 1)).toBe(15 * 60_000);
    expect(nextCheckDelay("unreachable", 3)).toBe(60 * 60_000);
    expect(nextCheckDelay("error", 20)).toBe(12 * 3_600_000);
    expect(nextCheckDelay("connected", 0)).toBe(6 * 3_600_000);
  });
});

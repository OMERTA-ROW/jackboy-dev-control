import { describe, expect, it } from "vitest";
import { analyzeHtml, autopilotOn, canAutoShip, extractLinks, nextPatch, sensitiveFiles } from "./autopilot";

describe("autopilot rules", () => {
  it("needs both master and project switches", () => {
    expect(autopilotOn(true, true)).toBe(true);
    expect(autopilotOn(false, true)).toBe(false);
    expect(autopilotOn(true, false)).toBe(false);
  });
  it("auto-ships only after passing checks", () => {
    const base = { master: true, project: true, paths: ["src/components/Footer.tsx"] };
    expect(canAutoShip({ ...base, checks: "success" }).ok).toBe(true);
    expect(canAutoShip({ ...base, checks: "pending" }).ok).toBe(false);
    expect(canAutoShip({ ...base, checks: "failure" }).ok).toBe(false);
    expect(canAutoShip({ ...base, checks: "none" }).ok).toBe(false);
    expect(canAutoShip({ ...base, project: false, checks: "success" }).ok).toBe(false);
  });
  it("never auto-ships sensitive files", () => {
    expect(sensitiveFiles(["src/lib/auth.ts", ".github/workflows/ci.yml", "supabase/config.toml", "src/App.tsx"])).toEqual(["src/lib/auth.ts", ".github/workflows/ci.yml", "supabase/config.toml"]);
    expect(canAutoShip({ master: true, project: true, checks: "success", paths: ["src/routes/checkout.tsx"] }).ok).toBe(false);
  });
  it("bumps patch versions", () => {
    expect(nextPatch("1.2.3")).toBe("1.2.4");
    expect(nextPatch(null)).toBe("0.1.0");
  });
  it("extracts and analyzes pages", () => {
    expect(extractLinks('<a href="/a">x</a><a href="mailto:x">y</a><a href="https://b.com/c#d">', "https://s.com/")).toEqual(["https://s.com/a", "https://b.com/c"]);
    const kinds = analyzeHtml('<html><body><form><input name="q"></form><img src="x"></body></html>', "https://s.com/").map((f) => f.kind);
    expect(kinds).toContain("forms");
    expect(kinds).toContain("seo");
    expect(kinds).toContain("accessibility");
  });
});

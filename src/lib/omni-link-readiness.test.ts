import { describe, expect, it } from "vitest";
import { REVERSE_LINK_VARS, reverseLinkReport } from "./omni-link-readiness";

const full = Object.fromEntries(REVERSE_LINK_VARS.map((n) => [n, n === "OMNI_LINK_ENABLED" ? "true" : "x"]));
const now = Date.parse("2026-11-03T23:00:00Z");

describe("OMNI-initiated link readiness", () => {
  it("fails and names missing variables without values", () => {
    const r = reverseLinkReport({ env: { OMNI_LINK_ENABLED: "true" }, configValid: false, storageReady: true, lastSessionAt: null });
    expect(r.verified).toBe(false);
    expect(r.missing[0]).toContain("OMNI_LINK_HMAC_SECRET");
  });
  it("fails when the migration is not applied", () => {
    const r = reverseLinkReport({ env: full, configValid: true, storageReady: false, lastSessionAt: "2026-11-04T00:00:00Z", now });
    expect(r.verified).toBe(false);
    expect(r.steps.find((step) => step.name === "Jackboy link storage")?.ok).toBe(false);
  });
  it("passes only after OMNI has actually opened a session", () => {
    expect(reverseLinkReport({ env: full, configValid: true, storageReady: true, lastSessionAt: null }).verified).toBe(false);
    expect(reverseLinkReport({ env: full, configValid: true, storageReady: true, lastSessionAt: "2026-11-04T00:00:00Z", now }).verified).toBe(true);
  });
  it("never treats an expired or invalid session as current connection evidence", () => {
    for (const lastSessionAt of ["2026-11-03T23:00:00Z", "2026-11-03T22:59:59Z", "invalid"]) {
      expect(reverseLinkReport({ env: full, configValid: true, storageReady: true, lastSessionAt, now }).verified).toBe(false);
    }
  });
  it("legacy OMNI keys alone never pass", () => {
    const r = reverseLinkReport({ env: { OMNI_API_KEY: "x", OMNI_CALLBACK_SECRET: "y" }, configValid: false, storageReady: false, lastSessionAt: null });
    expect(r.verified).toBe(false);
  });
});

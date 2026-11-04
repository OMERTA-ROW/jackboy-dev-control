import { describe, expect, it } from "vitest";
import { REVERSE_LINK_VARS, reverseLinkReport } from "./omni-link-readiness";

const full = Object.fromEntries(REVERSE_LINK_VARS.map((n) => [n, n === "OMNI_LINK_ENABLED" ? "true" : "x"]));

describe("OMNI-initiated link readiness", () => {
  it("fails and names missing variables without values", () => {
    const r = reverseLinkReport({ env: { OMNI_LINK_ENABLED: "true" }, configValid: false, storageReady: true, lastSessionAt: null });
    expect(r.verified).toBe(false);
    expect(r.missing[0]).toContain("OMNI_LINK_HMAC_SECRET");
  });
  it("fails when the migration is not applied", () => {
    const r = reverseLinkReport({ env: full, configValid: true, storageReady: false, lastSessionAt: "2026-11-04T00:00:00Z" });
    expect(r.verified).toBe(false);
    expect(r.missing).toEqual(["Migration 0030_omni_sessions.sql is not applied"]);
  });
  it("passes only after OMNI has actually opened a session", () => {
    expect(reverseLinkReport({ env: full, configValid: true, storageReady: true, lastSessionAt: null }).verified).toBe(false);
    expect(reverseLinkReport({ env: full, configValid: true, storageReady: true, lastSessionAt: "2026-11-04T00:00:00Z" }).verified).toBe(true);
  });
  it("legacy OMNI keys alone never pass", () => {
    const r = reverseLinkReport({ env: { OMNI_API_KEY: "x", OMNI_CALLBACK_SECRET: "y" }, configValid: false, storageReady: false, lastSessionAt: null });
    expect(r.verified).toBe(false);
  });
});

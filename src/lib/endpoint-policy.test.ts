import { describe, expect, it } from "vitest";
import { alertDedupeKey, evaluatePatch, inWindow, stepAlert, type EndpointFacts, type PatchCandidate } from "./endpoint-policy";

const e: EndpointFacts = { os: "macos", arch: "arm64", ring: "canary", enrolled: true, diskFreePct: 40, cpuPct: 20, memPct: 40 };
const p: PatchCandidate = { workstream: "endpoint_patch", os: ["macos"], arch: ["arm64"], severity: "high", signatureVerified: true, provenanceTrusted: true, requiresReboot: false, ownerApproved: true, allowedRings: ["canary"] };
const w = { startHourUtc: 2, endHourUtc: 5, allowReboot: false };

describe("endpoint patch policy", () => {
  it("allows a signed, approved, compatible patch in window", () => expect(evaluatePatch(p, e, w, 3).allow).toBe(true));
  it("blocks unenrolled endpoints", () => expect(evaluatePatch(p, { ...e, enrolled: false }, w, 3).allow).toBe(false));
  it("blocks unsigned packages", () => expect(evaluatePatch({ ...p, signatureVerified: false }, e, w, 3).allow).toBe(false));
  it("blocks untrusted provenance", () => expect(evaluatePatch({ ...p, provenanceTrusted: false }, e, w, 3).allow).toBe(false));
  it("blocks wrong OS", () => expect(evaluatePatch(p, { ...e, os: "windows" }, w, 3).allow).toBe(false));
  it("blocks wrong arch", () => expect(evaluatePatch(p, { ...e, arch: "x64" }, w, 3).allow).toBe(false));
  it("blocks rings not yet released", () => expect(evaluatePatch(p, { ...e, ring: "broad" }, w, 3).allow).toBe(false));
  it("blocks outside window", () => expect(evaluatePatch(p, e, w, 12).allow).toBe(false));
  it("blocks reboot when window forbids it", () => expect(evaluatePatch({ ...p, requiresReboot: true }, e, w, 3).allow).toBe(false));
  it("blocks under 10% free disk", () => expect(evaluatePatch(p, { ...e, diskFreePct: 9 }, w, 3).allow).toBe(false));
  it("requires owner approval even for critical", () => {
    const d = evaluatePatch({ ...p, severity: "critical", ownerApproved: false }, e, w, 3);
    expect(d.allow).toBe(false); expect(d.needsApproval).toBe(true);
  });
  it("keeps code repair out of endpoint patching", () => expect(evaluatePatch({ ...p, workstream: "code_repair" }, e, w, 3).allow).toBe(false));
  it("handles windows wrapping midnight", () => expect(inWindow(1, { startHourUtc: 22, endHourUtc: 3, allowReboot: true })).toBe(true));
});

describe("monitoring hysteresis", () => {
  const rule = { threshold: 90, clearBelow: 75, forSamples: 3 };
  it("opens only after 3 consecutive breaches", () => {
    let s = { firing: false, breachCount: 0 };
    const opens = [95, 95, 95].map((v) => { const r = stepAlert(s, v, rule); s = r.state; return r.open; });
    expect(opens).toEqual([false, false, true]);
  });
  it("resets on a dip", () => expect(stepAlert({ firing: false, breachCount: 2 }, 50, rule).state.breachCount).toBe(0));
  it("stays firing between thresholds", () => expect(stepAlert({ firing: true, breachCount: 3 }, 80, rule).close).toBe(false));
  it("closes below clear level", () => expect(stepAlert({ firing: true, breachCount: 3 }, 70, rule).close).toBe(true));
  it("dedupes by endpoint+metric", () => expect(alertDedupeKey("a", "cpu")).toBe("endpoint:a:cpu"));
});

import { describe, expect, it } from "vitest";
import {
  PUBLISHED_RP_ID,
  READINESS,
  acceptanceResult,
  appPrivilegeResult,
  combine,
  gatewayObservation,
  latestTests,
  passkeyObservation,
  spendObservation,
} from "./readiness";

describe("readiness rules", () => {
  it("every item has a Test", () => {
    expect(READINESS).toHaveLength(12);
    expect(new Set(READINESS.map((r) => r.id)).size).toBe(12);
  });
  it("only items with an existing passkey-gated control get Block/Unblock", () => {
    const withControls = READINESS.filter((r) => r.block || r.unblock).map((r) => r.id).sort();
    expect(withControls).toEqual(["code_runtime", "spend_enforcement"]);
  });
  it("nothing recorded means NOT TESTED, never PASS", () => {
    expect(combine(undefined, null).status).toBe("NOT TESTED");
  });
  it("newer real use replaces an older test, and a newer test replaces older use", () => {
    const test = { item: "provider_gateway", status: "BLOCKED" as const, reason: "x", at: "2026-11-07T01:00:00Z" };
    const live = { status: "PASS" as const, reason: "y", at: "2026-11-07T02:00:00Z", source: "live" as const };
    expect(combine(test, live).status).toBe("PASS");
    expect(combine({ ...test, at: "2026-11-07T03:00:00Z" }, live).status).toBe("BLOCKED");
  });
  it("ignores malformed or unknown stored test rows", () => {
    const m = latestTests([
      { at: "2026-11-07T01:00:00Z", detail: { item: "omni_prs", status: "PASS", reason: "ok" } },
      { at: "2026-11-07T02:00:00Z", detail: { item: "omni_prs", status: "MAGIC", reason: "bad" } },
      { at: "2026-11-07T02:00:00Z", detail: { item: "made_up", status: "PASS", reason: "bad" } },
    ]);
    expect(m.get("omni_prs")?.reason).toBe("ok");
    expect(m.has("made_up")).toBe(false);
  });
  it("a passkey only counts as physical-device proof on the live site", () => {
    expect(passkeyObservation([{ at: "2026-11-07T01:00:00Z", rpId: "localhost", action: "x" }])).toBeNull();
    expect(passkeyObservation([{ at: "2026-11-07T01:00:00Z", rpId: PUBLISHED_RP_ID, action: "code enable" }])?.status).toBe("PASS");
  });
  it("only a settled gateway call proves the gateway", () => {
    expect(gatewayObservation({ finishedAt: "2026-11-07T01:00:00Z", status: "settled", model: "m" })?.status).toBe("PASS");
    expect(gatewayObservation({ finishedAt: "2026-11-07T01:00:00Z", status: "aborted", model: "m" })).toBeNull();
    expect(gatewayObservation(null)).toBeNull();
  });
  it("spending passes only with guard, meter and hard cap all in place", () => {
    expect(spendObservation({ guardOk: true, meterOk: true, hardCap: true, reasons: [] }, "t").status).toBe("PASS");
    expect(spendObservation({ guardOk: true, meterOk: false, hardCap: true, reasons: [] }, "t").status).toBe("BLOCKED");
  });
  it("runner acceptance must pass on current main", () => {
    const run = { status: "completed", conclusion: "success", headSha: "a".repeat(40), createdAt: "" };
    expect(acceptanceResult(run, "a".repeat(40)).status).toBe("PASS");
    expect(acceptanceResult(run, "b".repeat(40)).status).toBe("OWNER ACTION");
    expect(acceptanceResult({ ...run, conclusion: "failure" }, "a".repeat(40)).status).toBe("BLOCKED");
  });
  it("a passing run on a commit with files identical to main counts; a failing one never does", () => {
    const run = { status: "completed", conclusion: "success", headSha: "a".repeat(40), createdAt: "" };
    expect(acceptanceResult(run, "b".repeat(40), true).status).toBe("PASS");
    expect(acceptanceResult(run, "b".repeat(40), false).status).toBe("OWNER ACTION");
    expect(acceptanceResult({ ...run, conclusion: "failure" }, "b".repeat(40), true).status).toBe("BLOCKED");
    expect(acceptanceResult({ ...run, status: "in_progress" }, "b".repeat(40), true).status).toBe("IN PROGRESS");
  });
  it("GitHub App fails least privilege with workflow write or all-repository access", () => {
    expect(appPrivilegeResult({ permissions: { contents: "write" }, selection: "selected" }).status).toBe("PASS");
    expect(appPrivilegeResult({ permissions: { workflows: "write" }, selection: "selected" }).status).toBe("OWNER ACTION");
    expect(appPrivilegeResult({ permissions: { contents: "write" }, selection: "all" }).status).toBe("OWNER ACTION");
  });
});

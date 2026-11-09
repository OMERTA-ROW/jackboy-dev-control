import { describe, expect, it } from "vitest";
import {
  classifyAudit,
  classifySite,
  guardianRules,
  guardianStatus,
  mergeEvents,
  validLimits,
} from "./guardian-overview";

describe("Guardian overview", () => {
  it("Guardian is never reported off; Kill Switch on or unreadable means held", () => {
    expect(guardianStatus({ paused: false }, false).state).toBe("on");
    expect(guardianStatus({ paused: true }, false).state).toBe("held");
    expect(guardianStatus(null, false).state).toBe("held");
    expect(guardianStatus({ paused: "?" }, true).state).toBe("held");
  });
  it("unverified Guardian is shown as unable to approve anything", () =>
    expect(guardianStatus({ paused: false }, false).approver).toMatch(/can't approve anything/));
  it("rules list owner-only capabilities from the live code", () => {
    const t = guardianRules()
      .map((r) => r.text)
      .join(" ");
    expect(t).toContain("production deployment");
    expect(t).toContain("credential changes");
    expect(t).toContain("Kill Switch beats every other setting");
  });
  it("Guardian checks map allow → allowed and deny → blocked", () => {
    const row = {
      id: "1",
      at: "2026-11-09T00:00:00Z",
      action: "guardian.check",
      detail: { name: "A", action: "deploy_production", reason: "Owner approval required." },
    };
    expect(classifyAudit({ ...row, outcome: "allow" })?.verdict).toBe("allowed");
    expect(classifyAudit({ ...row, outcome: "deny" })?.verdict).toBe("blocked");
  });
  it("owner-routed automation decisions are flagged, voice refusals blocked", () => {
    expect(
      classifyAudit({
        id: "2",
        at: "t",
        action: "automation.decision",
        outcome: "owner",
        detail: { route: "owner", reasons: ["Production deployment."] },
      })?.verdict,
    ).toBe("flagged");
    expect(
      classifyAudit({
        id: "3",
        at: "t",
        action: "chat.voice_blocked",
        outcome: "denied",
        detail: { tool: "setAutopilot" },
      })?.verdict,
    ).toBe("blocked");
  });
  it("unrelated actions are ignored", () => {
    expect(
      classifyAudit({ id: "4", at: "t", action: "hub.token.issue", outcome: "ok", detail: {} }),
    ).toBeNull();
    expect(
      classifySite({ id: 5, at: "t", action: "readiness.test", status: "blocked", summary: "x" }),
    ).toBeNull();
  });
  it("OMNI refusals are blocked and accepted jobs allowed", () => {
    expect(
      classifySite({
        id: 6,
        at: "t",
        action: "omni.chat_job.refused",
        status: "failed",
        summary: "Kill Switch is on",
      })?.verdict,
    ).toBe("blocked");
    expect(
      classifySite({
        id: 7,
        at: "t",
        action: "omni.chat_job.submitted",
        status: "pending",
        summary: "ok",
      })?.verdict,
    ).toBe("allowed");
  });
  it("merges newest first and caps", () => {
    const e = (id: string, at: string) => ({
      id,
      at,
      verdict: "allowed" as const,
      area: "x",
      reason: "y",
    });
    expect(
      mergeEvents([
        [e("a", "2026-01-01"), null],
        [e("b", "2026-02-01"), e("a", "2026-01-01")],
      ]).map((x) => x.id),
    ).toEqual(["b", "a"]);
    expect(mergeEvents([[e("a", "1"), e("b", "2"), e("c", "3")]], 2)).toHaveLength(2);
  });
  it("limits match the server ranges", () => {
    expect(validLimits({ tier: 1, maxFiles: 3, maxLines: 50 })).toBeNull();
    expect(validLimits({ tier: 3, maxFiles: 3, maxLines: 50 })).not.toBeNull();
    expect(validLimits({ tier: 0, maxFiles: 21, maxLines: 50 })).not.toBeNull();
    expect(validLimits({ tier: 0, maxFiles: 3, maxLines: 0 })).not.toBeNull();
  });
});

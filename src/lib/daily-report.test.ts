import { describe, expect, it } from "vitest";
import { buildDailyReport, pushText, reportDue } from "./daily-report";

const base = {
  date: "2026-11-07",
  activity: { codeRequests: 2, runsSucceeded: 1, runsFailed: 1, draftPrs: 1, inspections: 3, findings: 0, undos: 0, mergedByOwner: 0 },
  spend: { yesterdayUsd: 0.28, todayUsd: 0, dailyLimitUsd: 5, totalUsd: 0.28, totalLimitUsd: 10, crossCheckProblem: false },
  waiting: [{ title: "Hercules run waiting for GitHub approval", link: "/chat" }],
  safety: { killSwitch: false, codeEnabled: true, autoStops: 0 },
};

describe("daily report", () => {
  it("summarises done, spent against the $5 and $10 limits, and what's waiting", () => {
    const r = buildDailyReport(base);
    expect(r.summary.split("\n")[0]).toBe("Jackboy 2026-11-07: 4 done · $0.28 spent · 1 waiting for you");
    expect(r.summary).toContain("Today so far $0.00 of $5.00. Total $0.28 of $10.00.");
    expect(r.summary).toContain("Inspections: 3, nothing new to fix.");
    expect(r.summary).toContain("Hercules run waiting for GitHub approval (/chat)");
  });
  it("says unavailable instead of guessing", () => {
    const r = buildDailyReport({ ...base, spend: null, waiting: null, activity: null, safety: null });
    expect(r.summary).toContain("spend unavailable");
    expect(r.summary).toContain("Approval list unavailable.");
    expect(r.summary).toContain("Activity records unavailable.");
    expect(r.summary).not.toContain("$");
  });
  it("flags a cross-check mismatch", () => {
    expect(buildDailyReport({ ...base, spend: { ...base.spend, crossCheckProblem: true } }).summary).toContain("does not match");
  });
  it("is due once, at 7 AM Eastern", () => {
    const at7 = Date.parse("2026-11-07T12:05:00Z");
    expect(reportDue(at7, "America/New_York", 7, null)).toEqual({ due: true, date: "2026-11-07" });
    expect(reportDue(at7, "America/New_York", 7, "2026-11-07").due).toBe(false);
    expect(reportDue(Date.parse("2026-11-07T13:05:00Z"), "America/New_York", 7, null).due).toBe(false);
    // Summer time: 7 AM EDT is 11:00 UTC.
    expect(reportDue(Date.parse("2026-07-01T11:05:00Z"), "America/New_York", 7, null).due).toBe(true);
  });
  it("phone version keeps it short and drops links", () => {
    const p = pushText(buildDailyReport(base));
    expect(p.body.length).toBeLessThanOrEqual(600);
    expect(p.body).toContain("Hercules run waiting for GitHub approval");
    expect(p.body).not.toContain("(/chat)");
  });
});

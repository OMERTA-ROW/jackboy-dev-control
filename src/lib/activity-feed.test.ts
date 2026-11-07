import { describe, expect, it } from "vitest";
import { feedFromEvents, runOutcome, runTrail, scanFraction, stallInfo, type RunEvent } from "./activity-feed";

const ev = (action: string, note: string, detail: Record<string, unknown> = {}, at = "2026-11-07T05:00:00Z", to_state: string | null = null): RunEvent =>
  ({ project_id: "p1", action, to_state, note, created_at: at, detail });

describe("live activity feed", () => {
  it("keeps only this run's events, from its start to its finish", () => {
    const events = [
      ev("inspect_finished", "Finished: old run", { runId: "old" }),
      ev("inspect_started", "Reading 51 files in o/omni; checking 40 source file(s)…", { runId: "r1" }),
      ev("scan_progress", "Checking file 1 of 40 · a.ts", { runId: "r1", done: 0, total: 40 }),
      ev("scan_progress", "Checking file 5 of 40 · x.ts", { runId: "other", done: 4, total: 40 }),
      ev("inspect_finished", "Finished: inspected 51 files; nothing new to fix.", { runId: "r1" }),
      ev("inspect_started", "later run", { runId: "r1-later" }),
    ];
    expect(runTrail(events, "r1").map((e) => e.action)).toEqual(["inspect_started", "scan_progress", "inspect_finished"]);
    expect(runTrail(events, "missing")).toEqual([]);
  });

  it("shows file-by-file progress as one updating line with its timestamp", () => {
    const trail = [
      ev("inspect_started", "Reading 51 files", { runId: "r" }, "2026-11-07T05:00:00Z"),
      ev("scan_progress", "Checking file 1 of 51 · a.ts", { runId: "r", done: 0, total: 51 }, "2026-11-07T05:00:01Z"),
      ev("scan_progress", "Checking file 12 of 51 · b.ts", { runId: "r", done: 11, total: 51 }, "2026-11-07T05:00:04Z"),
    ];
    const feed = feedFromEvents(trail);
    expect(feed).toHaveLength(2);
    expect(feed[1]!.text).toBe("Inspecting file 12 of 51 · b.ts");
    expect(feed[1]!.at).toBe(Date.parse("2026-11-07T05:00:04Z"));
    expect(scanFraction(trail)).toBeCloseTo(11 / 51);
  });

  it("says plainly when the scan found nothing to fix", () => {
    const feed = feedFromEvents([ev("code_scan", "Scanned 40 source file(s) in o/omni; 0 finding(s).", { findings: 0 })]);
    expect(feed[0]!.text).toContain("Found nothing to fix.");
    expect(feed[0]!.tone).toBe("ok");
    expect(scanFraction([ev("code_scan", "x", { findings: 0 })])).toBe(1);
  });

  it("has no percentage before any progress mark (bar moves instead)", () => {
    expect(scanFraction([])).toBeNull();
    expect(scanFraction([ev("inspect_started", "Reading")])).toBeNull();
  });

  it("flags a stall after 45 s of silence on a normal step", () => {
    expect(stallInfo(0, 45_000, []).stalled).toBe(false);
    expect(stallInfo(0, 46_000, []).stalled).toBe(true);
    expect(stallInfo(0, 46_000, [ev("scan_progress", "x")]).stalled).toBe(true);
  });

  it("gives AI fix writing up to 2 minutes before calling it stalled", () => {
    const writing = [ev("transition", "Generating a minimal fix with AI.", {}, "2026-11-07T05:00:00Z", "analyzing")];
    expect(stallInfo(0, 100_000, writing).stalled).toBe(false);
    expect(stallInfo(0, 121_000, writing).stalled).toBe(true);
  });

  it("ends the run clearly when there is nothing to do", () => {
    expect(runOutcome({ created: 0, inspectedFiles: 51 })).toEqual({ phase: "nothing", text: "Inspected 51 files; nothing new to fix. Run ended." });
    expect(runOutcome({ created: 1, inspectedFiles: 51 }).phase).toBe("done");
    expect(runOutcome({ created: 0, blocked: "Queued: OMNI already has an active task." }).phase).toBe("nothing");
    expect(runOutcome({ created: 0, blocked: "No GitHub repo linked to this project." }).phase).toBe("blocked");
    expect(runOutcome({ created: 0, stopped: true }).phase).toBe("stopped");
  });
});

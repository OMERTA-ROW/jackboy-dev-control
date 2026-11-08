import { describe, expect, it } from "vitest";
import { summarizeAutonomy, type AutonomyInput } from "./autonomy-status";

const now = Date.parse("2026-11-07T16:00:00Z");
const h = (n: number) => new Date(now - n * 3600_000).toISOString();
const base = (o: Partial<AutonomyInput> = {}): AutonomyInput => ({
  now, killSwitch: false,
  projects: [
    { name: "OMNI", repo: "o/omni", devEnabled: true, autopilot: false },
    { name: "Vera", repo: null, devEnabled: true, autopilot: false },
    { name: "Mothership", repo: "o/m", devEnabled: false, autopilot: true },
  ],
  autopilotMaster: false, pauseReason: null,
  foundry: { enabled: false, paused: true, lastTickAt: h(96) },
  updateWriterLastRunAt: h(130), siteCheckedAt: null, alertsHeartbeatAt: h(0.2),
  code: { enabled: true, killSwitch: false, hardCap: true, meterOk: true, failures: 0, activeRun: false, targets: ["OMERTA-ROW/jackboy-dev-control"] },
  omniVerified: false, ...o,
});
const row = (rows: { id: string; state: string }[], id: string) => rows.find((r) => r.id === id)?.state;

describe("What's really running", () => {
  it("switches on without a firing hourly job are not reported as running", () => {
    const s = summarizeAutonomy(base());
    expect(s.unattended).toBe(false);
    expect(row(s.lovable, "background")).toBe("on");
    expect(row(s.schedules, "hourly")).toBe("not_running");
    expect(s.headline.lovable).toMatch(/nothing runs on its own/);
  });
  it("counts only projects with a repo as inspectable", () => {
    const s = summarizeAutonomy(base());
    expect(s.lovable.find((r) => r.id === "background")?.detail).toContain("2 of 3 projects; 1 of those");
  });
  it("per-project Autopilot does nothing while the master switch is off", () => {
    const s = summarizeAutonomy(base());
    expect(s.lovable.find((r) => r.id === "autopilot")?.detail).toMatch(/Mothership\) does nothing/);
  });
  it("is unattended only with Kill Switch off, a fresh hourly job and an engine on", () => {
    expect(summarizeAutonomy(base({ foundry: { enabled: true, paused: false, lastTickAt: h(0.5) } })).unattended).toBe(true);
    expect(summarizeAutonomy(base({ killSwitch: true, foundry: { enabled: true, paused: false, lastTickAt: h(0.5) } })).unattended).toBe(false);
    expect(summarizeAutonomy(base({ killSwitch: null, foundry: { enabled: true, paused: false, lastTickAt: h(0.5) } })).unattended).toBe(false);
    expect(summarizeAutonomy(base({ pauseReason: "Not enough credits", foundry: { enabled: true, paused: false, lastTickAt: h(0.5) } })).unattended).toBe(false);
  });
  it("keeps GitHub CODE state separate and blocks after two failures", () => {
    const s = summarizeAutonomy(base({ code: { enabled: true, killSwitch: false, hardCap: true, meterOk: true, failures: 2, activeRun: false, targets: [] } }));
    expect(row(s.code, "code-fail")).toBe("blocked");
    expect(row(s.code, "code-sites")).toBe("blocked");
    expect(s.headline.code).toMatch(/GitHub approval/);
  });
  it("treats unreadable CODE controls as off and OMNI unverified as blocked", () => {
    const s = summarizeAutonomy(base({ code: null }));
    expect(s.headline.code).toMatch(/treated as off/);
    expect(s.omni.state).toBe("blocked");
  });
  it("lists merge, publish, secrets and billing as owner-only", () => {
    const s = summarizeAutonomy(base());
    expect(s.ownerOnly.join(" ")).toMatch(/Merging.*Publishing.*secrets.*Billing/s);
  });
});

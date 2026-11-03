import { describe, it, expect } from "vitest";
import { buildJackboyManifest } from "./agent-manifest";
import { toTester } from "./capabilities";
const m = buildJackboyManifest({ ai: true, githubRepo: { ok: true, usable: 2 }, actionsRead: true, projectsWithSite: 3, voiceServer: true, outboxTargets: 0, omniVerified: false });
const get = (s: ReturnType<typeof toTester>, id: string) => s.find((c) => c.id === id)!;
describe("toTester", () => {
  it("emergency pause disables every action", () => { expect(toTester(m, { emergencyPause: true, schedules: false, autopilot: false }).some((c) => c.actionsActive)).toBe(false); });
  it("deploy is never active, even unpaused", () => { expect(get(toTester(m, { emergencyPause: false, schedules: false, autopilot: false }), "deploy").actionsActive).toBe(false); });
  it("unverified OMNI is not connected", () => { expect(get(toTester(m, { emergencyPause: false, schedules: false, autopilot: false }), "omni_delegate").status).toBe("not_connected"); });
  it("voice is needs_testing, never working", () => { expect(get(toTester(m, { emergencyPause: false, schedules: false, autopilot: false }), "voice").status).toBe("needs_testing"); });
});

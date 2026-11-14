import { describe, expect, it } from "vitest";
import { NOT_INSTALLED_LOCK, safetyControlsView, type SafetyControlsInput } from "./safety-controls";

const IDS = ["no_task", "failures", "spike", "cancellation", "hard_cap", "total_guard", "meter", "pins", "gateway", "cost_check"];
const RELEASE_IDS = ["no_task", "failures", "spike", "cancellation", "hard_cap", "total_guard"];
const gates = (failing: string[] = [], ids = IDS) => ids.map((id) => ({ id, label: id, ok: !failing.includes(id), detail: `${id} detail` }));
const code = (enabled: boolean, killSwitch: boolean) => ({ enabled, killSwitch, activeRequestId: null, activeRunId: null });
const STOPPED = code(false, true);
const view = (patch: Partial<SafetyControlsInput>) =>
  safetyControlsView({ globalPaused: true, code: STOPPED, gates: gates(), releaseGates: gates([], RELEASE_IDS), independent: true, ...patch });

describe("three independent safety controls", () => {
  it("current founder state: Kill Switch on, Emergency Stop engaged, CODE saved OFF — nothing can run", () => {
    const v = view({});
    expect(v.killSwitch.status).toBe("on");
    expect(v.emergencyStop.status).toBe("engaged");
    expect(v.code.status).toBe("off");
    expect(v.execution).toEqual({ allowed: false, blockedBy: ["Kill Switch is on", "CODE Emergency Stop is engaged", "CODE is saved as OFF"] });
  });

  it("each control's actions do not depend on the other two controls", () => {
    for (const globalPaused of [true, false]) for (const killSwitch of [true, false]) {
      const off = view({ globalPaused, code: code(false, killSwitch) });
      expect(off.code.canTurnOn).toBe(true);
      expect(off.code.unmet).toEqual([]);
      const on = view({ globalPaused, code: code(true, killSwitch) });
      expect(on.code.canTurnOff).toBe(true);
    }
    for (const globalPaused of [true, false]) for (const enabled of [true, false]) {
      expect(view({ globalPaused, code: code(enabled, true) }).emergencyStop.canRelease).toBe(true);
      expect(view({ globalPaused, code: code(enabled, false) }).emergencyStop.canEngage).toBe(true);
      expect(view({ globalPaused, code: code(enabled, true) }).killSwitch.canToggle).toBe(true);
    }
  });

  it("shows the saved CODE setting separately from whether CODE can run", () => {
    const v = view({ globalPaused: true, code: code(true, true) });
    expect(v.code.status).toBe("on");
    expect(v.execution.allowed).toBe(false);
    expect(v.execution.blockedBy).toEqual(["Kill Switch is on", "CODE Emergency Stop is engaged"]);
  });

  it("all 8 combinations: CODE can run only with Kill Switch off, stop released and CODE saved ON", () => {
    for (const globalPaused of [true, false]) for (const killSwitch of [true, false]) for (const enabled of [true, false]) {
      expect(view({ globalPaused, code: code(enabled, killSwitch) }).execution.allowed).toBe(!globalPaused && !killSwitch && enabled);
    }
  });

  it("execution also stays blocked when any requirement fails, even with all three controls allowing work", () => {
    for (const id of IDS) {
      const v = view({ globalPaused: false, code: code(true, false), gates: gates([id]) });
      expect(v.execution.allowed).toBe(false);
      expect(v.execution.blockedBy.length).toBe(1);
    }
  });

  it("any failing requirement keeps the CODE switch locked and is listed with a fix", () => {
    for (const id of IDS) {
      const v = view({ gates: gates([id]) });
      expect(v.code.canTurnOn).toBe(false);
      expect(v.code.unmet.map((u) => u.id)).toEqual([id]);
      expect(v.code.unmet[0]?.fix.length).toBeGreaterThan(0);
      expect(v.code.lockReason).toBe("Locked: 1 requirement is not met.");
    }
  });

  it("any failing release requirement keeps the release locked, but engaging is never blocked", () => {
    for (const id of RELEASE_IDS) {
      const v = view({ releaseGates: gates([id], RELEASE_IDS) });
      expect(v.emergencyStop.canRelease).toBe(false);
      expect(v.emergencyStop.releaseUnmet.map((u) => u.id)).toEqual([id]);
      expect(v.emergencyStop.lockReason).toMatch(/Release locked/);
    }
    expect(view({ code: code(true, false), releaseGates: null, gates: null }).emergencyStop.canEngage).toBe(true);
  });

  it("unreadable checks or state fail closed", () => {
    expect(view({ gates: null }).code.canTurnOn).toBe(false);
    expect(view({ gates: [] }).code.canTurnOn).toBe(false);
    expect(view({ releaseGates: null }).emergencyStop.canRelease).toBe(false);
    expect(view({ releaseGates: undefined }).emergencyStop.canRelease).toBe(false);
    const unknown = view({ globalPaused: false, code: null });
    expect(unknown.code.status).toBe("unknown");
    expect(unknown.code.canTurnOn).toBe(false);
    expect(unknown.code.canTurnOff).toBe(false);
    expect(unknown.emergencyStop.canEngage).toBe(true);
    expect(unknown.emergencyStop.canRelease).toBe(false);
    expect(unknown.execution.allowed).toBe(false);
    const k = view({ globalPaused: null, code: code(true, false) });
    expect(k.killSwitch.canToggle).toBe(false);
    expect(k.execution.blockedBy).toContain("Kill Switch state unreadable");
    expect(view({ globalPaused: false, code: code(true, false), gates: null }).execution.allowed).toBe(false);
  });

  it("until the database change is installed, the new CODE and release actions are locked but the stop still engages", () => {
    for (const independent of [false, null, undefined]) {
      const v = view({ independent, globalPaused: false });
      expect(v.independent).toBe(false);
      expect(v.code.canTurnOn).toBe(false);
      expect(v.code.lockReason).toBe(NOT_INSTALLED_LOCK);
      expect(v.emergencyStop.canRelease).toBe(false);
      expect(v.emergencyStop.lockReason).toBe(NOT_INSTALLED_LOCK);
      expect(view({ independent, code: code(true, false) }).code.canTurnOff).toBe(false);
      expect(view({ independent, code: code(true, false) }).emergencyStop.canEngage).toBe(true);
      expect(v.killSwitch.canToggle).toBe(true);
      expect(view({ independent }).killSwitch.effect).toMatch(/Turning it off does NOT turn CODE back on/);
    }
    expect(view({ independent: false, globalPaused: false }).killSwitch.effect).toMatch(/also engages the CODE Emergency Stop/);
    expect(view({ independent: true, globalPaused: false }).killSwitch.effect).toMatch(/does not change the saved CODE setting/);
  });
});

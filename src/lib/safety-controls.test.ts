import { describe, expect, it } from "vitest";
import { safetyControlsView, type SafetyControlsInput } from "./safety-controls";

const IDS = ["stopped", "no_task", "failures", "spike", "cancellation", "hard_cap", "total_guard", "meter", "global_pause", "pins", "gateway", "cost_check"];
const gates = (failing: string[] = []) => IDS.map((id) => ({ id, label: id, ok: !failing.includes(id), detail: `${id} detail` }));
const STOPPED = { enabled: false, killSwitch: true, activeRequestId: null, activeRunId: null };
const ON = { enabled: true, killSwitch: false, activeRequestId: null, activeRunId: null };
const view = (patch: Partial<SafetyControlsInput>) =>
  safetyControlsView({ globalPaused: true, code: STOPPED, gates: gates(["global_pause"]), ...patch });

describe("three separate safety controls", () => {
  it("current founder state: Kill Switch on, Emergency Stop engaged, CODE off — and nothing can run", () => {
    const v = view({});
    expect(v.killSwitch.status).toBe("on");
    expect(v.emergencyStop.status).toBe("engaged");
    expect(v.code.status).toBe("off");
    expect(v.execution.allowed).toBe(false);
    expect(v.execution.blockedBy).toEqual(["Kill Switch is on", "CODE Emergency Stop is engaged", "CODE is off"]);
  });

  it("CODE switch is locked while the Kill Switch is on, and the Kill Switch is the first reason", () => {
    const v = view({ gates: gates(["global_pause", "pins"]) });
    expect(v.code.canTurnOn).toBe(false);
    expect(v.code.unmet.map((u) => u.id)).toEqual(["global_pause", "pins"]);
    expect(v.code.lockReason).toBe("Locked: the Kill Switch is on and 1 other requirement is not met.");
  });

  it("the live Kill Switch read locks CODE even if an older gate list said the pause was off", () => {
    const v = view({ globalPaused: true, gates: gates() });
    expect(v.code.canTurnOn).toBe(false);
    expect(v.code.unmet[0]?.id).toBe("global_pause");
  });

  it("releasing the Kill Switch alone does not turn CODE on", () => {
    const v = view({ globalPaused: false, gates: gates() });
    expect(v.killSwitch.status).toBe("off");
    expect(v.code.status).toBe("off");
    expect(v.execution.allowed).toBe(false);
    expect(v.execution.blockedBy).toEqual(["CODE Emergency Stop is engaged", "CODE is off"]);
    // Only now does the CODE switch become usable, and only because every gate passes.
    expect(v.code.canTurnOn).toBe(true);
    expect(v.code.unmet).toEqual([]);
  });

  it("any single failing requirement keeps the CODE switch locked and is listed with a fix", () => {
    for (const id of IDS.filter((i) => i !== "global_pause")) {
      const v = view({ globalPaused: false, gates: gates([id]) });
      expect(v.code.canTurnOn).toBe(false);
      expect(v.code.unmet.map((u) => u.id)).toEqual([id]);
      expect(v.code.unmet[0]?.fix.length).toBeGreaterThan(0);
    }
  });

  it("unreadable checks or CODE state never unlock the CODE switch", () => {
    expect(view({ globalPaused: false, gates: null }).code.canTurnOn).toBe(false);
    expect(view({ globalPaused: false, gates: [] }).code.canTurnOn).toBe(false);
    const unknown = view({ globalPaused: false, code: null, gates: gates() });
    expect(unknown.code.status).toBe("unknown");
    expect(unknown.code.canTurnOn).toBe(false);
    expect(unknown.execution.allowed).toBe(false);
  });

  it("an unreadable Kill Switch cannot be toggled and blocks execution", () => {
    const v = view({ globalPaused: null });
    expect(v.killSwitch.canToggle).toBe(false);
    expect(v.killSwitch.lockReason).not.toBeNull();
    expect(v.code.canTurnOn).toBe(false);
    expect(v.execution.blockedBy).toContain("Kill Switch state unreadable");
  });

  it("the Emergency Stop can be engaged whenever it is not already engaged, even with CODE disabled or state unknown", () => {
    expect(view({}).emergencyStop.canEngage).toBe(false);
    expect(view({ code: { ...STOPPED, killSwitch: false } }).emergencyStop.canEngage).toBe(true);
    expect(view({ code: null }).emergencyStop.canEngage).toBe(true);
    expect(view({ globalPaused: false, code: ON, gates: gates(["stopped"]) }).emergencyStop.canEngage).toBe(true);
  });

  it("CODE counts as running-allowed only with Kill Switch off, CODE enabled and stop released", () => {
    const v = view({ globalPaused: false, code: ON, gates: gates(["stopped"]) });
    expect(v.code.status).toBe("on");
    expect(v.code.canTurnOff).toBe(true);
    expect(v.code.canTurnOn).toBe(false);
    expect(v.code.unmet).toEqual([]);
    expect(v.execution.allowed).toBe(true);
    expect(view({ globalPaused: true, code: ON, gates: gates(["stopped"]) }).execution.allowed).toBe(false);
    expect(view({ globalPaused: false, code: { ...ON, killSwitch: true }, gates: gates() }).execution.allowed).toBe(false);
  });
});

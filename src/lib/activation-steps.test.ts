import { describe, expect, it } from "vitest";
import { activationProgress, activationSteps, codeIsOn, gateFix } from "./activation-steps";
import type { CodeEnableGate } from "./code-safety";

// Server requirements for turning CODE on (the three controls are NOT among them).
const IDS = ["no_task", "failures", "spike", "cancellation", "hard_cap", "total_guard", "meter", "pins", "gateway", "cost_check"];
const CONTROL_IDS = ["global_pause", "stop_released", "code_enabled"];
const gates = (failing: string[] = []): CodeEnableGate[] =>
  IDS.map((id) => ({ id, label: id, ok: !failing.includes(id), detail: "" }));
const OFF = { enabled: false, killSwitch: true };
const ALL_ON = { enabled: true, killSwitch: false };

describe("activation steps", () => {
  it("lists all eight steps in the owner's order, ending with the three separate controls", () => {
    expect(activationSteps(gates(), OFF, true).map((s) => s.id)).toEqual([
      "settings", "pins", "spending", "hard_cap", "clear", "global_pause", "release_stop", "turn_on",
    ]);
  });
  it("covers every server requirement and every control exactly once", () => {
    const covered = activationSteps(gates(), OFF, true).flatMap((s) => s.gates.map((g) => g.id)).sort();
    expect(covered).toEqual([...IDS, ...CONTROL_IDS].sort());
  });
  it("marks the first unfinished step current and later ones waiting", () => {
    const steps = activationSteps(gates(["hard_cap"]), OFF, true);
    expect(steps.find((s) => s.id === "spending")?.status).toBe("done");
    expect(steps.find((s) => s.id === "hard_cap")?.status).toBe("current");
    expect(steps.find((s) => s.id === "global_pause")?.status).toBe("waiting");
    expect(steps.find((s) => s.id === "turn_on")?.status).toBe("waiting");
  });
  it("a requirement the server did not report never counts as passed", () => {
    const steps = activationSteps(gates().filter((g) => g.id !== "meter"), OFF, false);
    expect(steps.find((s) => s.id === "spending")?.status).toBe("current");
  });
  it("control steps come from live state, not from a server gate with the same id", () => {
    const fake = [...gates(), { id: "global_pause", label: "x", ok: true, detail: "" }];
    expect(activationSteps(fake, OFF, true).find((s) => s.id === "global_pause")?.gates[0]?.ok).toBe(false);
    expect(activationSteps(gates(), OFF, null).find((s) => s.id === "global_pause")?.gates[0]?.ok).toBe(false);
  });
  it("is complete only when the Kill Switch is off, the stop is released and CODE is saved ON", () => {
    for (const globalPaused of [true, false, null]) for (const killSwitch of [true, false]) for (const enabled of [true, false]) {
      const done = activationProgress(activationSteps(gates(), { enabled, killSwitch }, globalPaused)).complete;
      expect(done).toBe(globalPaused === false && !killSwitch && enabled);
    }
    expect(activationProgress(activationSteps(gates(), ALL_ON, false))).toEqual({ done: 8, total: 8, complete: true });
    expect(activationProgress(activationSteps(gates(["meter"]), ALL_ON, false)).complete).toBe(false);
    expect(codeIsOn({ enabled: false, killSwitch: false })).toBe(false);
  });
});

describe("gate fixes", () => {
  it("every server requirement and control has its own plain-words fix", () => {
    const generic = gateFix("unknown-gate");
    for (const id of [...IDS, ...CONTROL_IDS]) expect(gateFix(id)).not.toBe(generic);
  });
});

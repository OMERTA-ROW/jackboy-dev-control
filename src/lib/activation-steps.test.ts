import { describe, expect, it } from "vitest";
import { activationProgress, activationSteps, codeIsOn } from "./activation-steps";
import type { CodeEnableGate } from "./code-safety";

const IDS = [
  "stopped",
  "no_task",
  "failures",
  "spike",
  "cancellation",
  "hard_cap",
  "total_guard",
  "meter",
  "global_pause",
  "pins",
  "gateway",
  "cost_check",
];
const gates = (failing: string[] = []): CodeEnableGate[] =>
  IDS.map((id) => ({ id, label: id, ok: !failing.includes(id), detail: "" }));
const OFF = { enabled: false, killSwitch: true };

describe("activation steps", () => {
  it("lists all seven steps in the owner's order", () => {
    expect(activationSteps(gates(), OFF).map((s) => s.id)).toEqual([
      "settings",
      "pins",
      "spending",
      "hard_cap",
      "clear",
      "global_pause",
      "turn_on",
    ]);
  });
  it("covers every server on-switch gate exactly once", () => {
    const covered = activationSteps(gates(), OFF)
      .flatMap((s) => s.gates.map((g) => g.id))
      .sort();
    expect(covered).toEqual([...IDS].sort());
  });
  it("marks the first unfinished step current and later ones waiting", () => {
    const steps = activationSteps(gates(["hard_cap", "global_pause"]), OFF);
    expect(steps.find((s) => s.id === "spending")?.status).toBe("done");
    expect(steps.find((s) => s.id === "hard_cap")?.status).toBe("current");
    expect(steps.find((s) => s.id === "global_pause")?.status).toBe("waiting");
    expect(steps.find((s) => s.id === "turn_on")?.status).toBe("waiting");
  });
  it("a gate the server did not report never counts as passed", () => {
    const steps = activationSteps(
      gates().filter((g) => g.id !== "meter"),
      OFF,
    );
    expect(steps.find((s) => s.id === "spending")?.status).toBe("current");
  });
  it("is complete only when CODE is enabled AND its stop is released", () => {
    expect(activationProgress(activationSteps(gates(), OFF)).complete).toBe(false);
    expect(
      activationProgress(activationSteps(gates(), { enabled: true, killSwitch: true })).complete,
    ).toBe(false);
    const on = activationProgress(
      activationSteps(gates(["stopped"]), { enabled: true, killSwitch: false }),
    );
    expect(on).toEqual({ done: 7, total: 7, complete: true });
    expect(codeIsOn({ enabled: false, killSwitch: false })).toBe(false);
  });
});

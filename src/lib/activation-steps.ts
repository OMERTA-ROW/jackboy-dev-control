import type { CodeEnableGate } from "./code-safety";

/** Ordered owner activation steps, built only from the server's on-switch gates.
 * This groups and orders what the server already checks; it never adds or relaxes a gate. */
export type ActivationStepId =
  "settings" | "pins" | "spending" | "hard_cap" | "clear" | "global_pause" | "turn_on";
export type ActivationStepStatus = "done" | "current" | "waiting";

export type ActivationStep = {
  id: ActivationStepId;
  title: string;
  hint: string;
  status: ActivationStepStatus;
  gates: CodeEnableGate[];
};

const STEPS: { id: ActivationStepId; title: string; hint: string; gates: string[] }[] = [
  {
    id: "settings",
    title: "Backend settings saved",
    hint: "Provider key, price table, per-call cap and OpenAI cost-report settings. Add any missing ones in Project Settings → Secrets.",
    gates: ["gateway", "cost_check"],
  },
  {
    id: "pins",
    title: "Workflow version matches",
    hint: "The database, CODE_TARGETS and GitHub main all point at the same workflow file.",
    gates: ["pins"],
  },
  {
    id: "spending",
    title: "Spending protection running",
    hint: "The $10 total guard and the live spending meter.",
    gates: ["total_guard", "meter"],
  },
  {
    id: "hard_cap",
    title: "Provider hard cap confirmed",
    hint: "You confirm the spending cap in your OpenAI project, then mark it here with your passkey.",
    gates: ["hard_cap"],
  },
  {
    id: "clear",
    title: "Nothing left over from earlier runs",
    hint: "No running task, no failure stop, no usage spike, no unconfirmed stopped run.",
    gates: ["no_task", "failures", "spike", "cancellation"],
  },
  {
    id: "global_pause",
    title: "Global pause off",
    hint: "The Kill Switch that pauses all Jackboy work. Turning it off needs your passkey.",
    gates: ["global_pause"],
  },
  {
    id: "turn_on",
    title: "Turn CODE on",
    hint: "Releases the CODE stop and turns CODE on. Needs a new passkey every time. Each run still needs your approval in GitHub.",
    gates: ["stopped"],
  },
];

/** CODE counts as on only when it is enabled AND its stop is released. */
export function codeIsOn(state: { enabled: boolean; killSwitch: boolean }): boolean {
  return state.enabled === true && state.killSwitch === false;
}

export function activationSteps(
  gates: CodeEnableGate[],
  state: { enabled: boolean; killSwitch: boolean },
): ActivationStep[] {
  const byId = new Map(gates.map((gate) => [gate.id, gate]));
  const on = codeIsOn(state);
  let blockedBefore = false;
  return STEPS.map((step) => {
    // A gate the server did not report counts as not passed: missing evidence never passes.
    const stepGates = step.gates.map(
      (id) => byId.get(id) ?? { id, label: id, ok: false, detail: "Not reported by the server." },
    );
    const done = step.id === "turn_on" ? on : stepGates.every((gate) => gate.ok);
    const status: ActivationStepStatus = done ? "done" : blockedBefore ? "waiting" : "current";
    if (!done) blockedBefore = true;
    return { id: step.id, title: step.title, hint: step.hint, status, gates: stepGates };
  });
}

/** Number of finished steps, for the "step N of 7" progress line. */
export function activationProgress(steps: ActivationStep[]): {
  done: number;
  total: number;
  complete: boolean;
} {
  const done = steps.filter((step) => step.status === "done").length;
  const last = steps[steps.length - 1];
  return { done, total: steps.length, complete: last?.id === "turn_on" && last.status === "done" };
}

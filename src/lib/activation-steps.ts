import type { CodeEnableGate } from "./code-safety";

/** Ordered owner activation steps, built only from the server's on-switch gates.
 * This groups and orders what the server already checks; it never adds or relaxes a gate. */
export type ActivationStepId =
  "settings" | "pins" | "spending" | "hard_cap" | "clear" | "global_pause" | "release_stop" | "turn_on";
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
  // The last three are the three separate controls; their state comes from the live reads.
  {
    id: "global_pause",
    title: "Kill Switch off",
    hint: "The Kill Switch pauses all Jackboy work. Turning it off needs your passkey and does not change CODE or the Emergency Stop.",
    gates: ["global_pause"],
  },
  {
    id: "release_stop",
    title: "Release the CODE Emergency Stop",
    hint: "Needs a new passkey. It does not turn CODE on or change the Kill Switch.",
    gates: ["stop_released"],
  },
  {
    id: "turn_on",
    title: "Turn CODE on",
    hint: "Saves CODE as ON. Needs a new passkey. It does not release the Emergency Stop or change the Kill Switch. Each run still needs your approval in GitHub.",
    gates: ["code_enabled"],
  },
];

/** CODE can run only when it is saved as ON AND its stop is released (and the Kill Switch is off). */
export function codeIsOn(state: { enabled: boolean; killSwitch: boolean }): boolean {
  return state.enabled === true && state.killSwitch === false;
}

/** Live control states as gates, so the three control steps read the same way as the others. */
function controlGates(state: { enabled: boolean; killSwitch: boolean }, globalPaused: boolean | null): CodeEnableGate[] {
  return [
    { id: "global_pause", label: "Kill Switch is off", ok: globalPaused === false, detail: globalPaused === null ? "Kill Switch state unreadable." : globalPaused ? "The Kill Switch is on." : "Off." },
    { id: "stop_released", label: "CODE Emergency Stop released", ok: state.killSwitch === false, detail: state.killSwitch ? "The Emergency Stop is engaged." : "Released." },
    { id: "code_enabled", label: "CODE saved as ON", ok: state.enabled === true, detail: state.enabled ? "Saved as ON." : "Saved as OFF." },
  ];
}

export function activationSteps(
  gates: CodeEnableGate[],
  state: { enabled: boolean; killSwitch: boolean },
  globalPaused: boolean | null = null,
): ActivationStep[] {
  // Control states always come from the live reads, never from a server gate with the same id.
  const controls = controlGates(state, globalPaused);
  const controlIds = new Set(controls.map((g) => g.id));
  const byId = new Map([...gates.filter((g) => !controlIds.has(g.id)), ...controls].map((gate) => [gate.id, gate]));
  let blockedBefore = false;
  return STEPS.map((step) => {
    // A gate the server did not report counts as not passed: missing evidence never passes.
    const stepGates = step.gates.map(
      (id) => byId.get(id) ?? { id, label: id, ok: false, detail: "Not reported by the server." },
    );
    const done = stepGates.every((gate) => gate.ok);
    const status: ActivationStepStatus = done ? "done" : blockedBefore ? "waiting" : "current";
    if (!done) blockedBefore = true;
    return { id: step.id, title: step.title, hint: step.hint, status, gates: stepGates };
  });
}

/** Number of finished steps, for the "step N of 8" progress line. */
export function activationProgress(steps: ActivationStep[]): {
  done: number;
  total: number;
  complete: boolean;
} {
  const done = steps.filter((step) => step.status === "done").length;
  // Complete only when every step is done: the three controls are independent, so the last one being
  // done says nothing about the others.
  return { done, total: steps.length, complete: steps.length > 0 && done === steps.length };
}

/** Plain-words fix for each server gate, shown when a guided step is blocked. Guidance only: it never
 * performs or relaxes anything. Unknown gates get a safe generic answer. */
const GATE_FIX: Record<string, string> = {
  gateway:
    "Add the CODE provider key, CODE_GATEWAY_PRICES and CODE_GATEWAY_PER_CALL_CAP_USD in Project Settings → Secrets, then press Check again.",
  cost_check:
    "Add OPENAI_ADMIN_KEY, OPENAI_CODE_PROJECT_ID and OPENAI_CODE_API_KEY_ID in Project Settings → Secrets, then press Check again.",
  pins: "The saved workflow version is different from GitHub main. Ask Jackboy in Chat for an owner-approved pin resync; nothing changes on its own.",
  total_guard:
    "The $10 total guard is missing or has no room left. Ask Jackboy in Chat to check it; changing the limit needs your separate approval.",
  meter:
    'The live spending meter reports a problem. Use "Check a past day against OpenAI" in CODE safety details below, or wait for OpenAI\'s daily report, then press Check again.',
  hard_cap:
    "Set a spending cap in your OpenAI project, write down what you checked, then press the button and confirm with your passkey.",
  no_task:
    'A task is still marked as running. Wait for it to finish, or use "Check status and retry cancellation" in CODE safety details below.',
  failures:
    "Two runs failed in a row, so CODE stopped itself. Review them in GitHub; clearing this needs an owner-approved fix.",
  spike:
    "A usage spike was recorded. Review spending first; clearing it needs your separate approval.",
  cancellation:
    'A stopped run is not yet confirmed finished. Use "Check status and retry cancellation" in CODE safety details below.',
  global_pause: "Press the button and confirm with your passkey.",
  stop_released: "Press Release Emergency Stop and confirm with a new passkey.",
  code_enabled: "Turn on the CODE switch and confirm with a new passkey.",
};

export function gateFix(id: string): string {
  return (
    GATE_FIX[id] ??
    "Ask Jackboy in Chat what this check needs. Nothing changes until you approve it."
  );
}

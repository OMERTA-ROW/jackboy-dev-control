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
    title: "Kill Switch off",
    hint: "The Kill Switch pauses all Jackboy work. Turning it off needs your passkey.",
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

/** Plain-words fix for each server gate, shown when a guided step is blocked. Guidance only: it never
 * performs or relaxes anything. Unknown gates get a safe generic answer. */
const GATE_FIX: Record<string, string> = {
  gateway:
    "Add CODE_PROVIDER_API_KEY, CODE_GATEWAY_PRICES and CODE_GATEWAY_PER_CALL_CAP_USD in Project Settings → Secrets, then press Check again.",
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
  stopped:
    "CODE is already on or its stop is released. Press Engage emergency stop to go back to a safe start.",
};

export function gateFix(id: string): string {
  return (
    GATE_FIX[id] ??
    "Ask Jackboy in Chat what this check needs. Nothing changes until you approve it."
  );
}

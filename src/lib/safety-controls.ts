import type { CodeEnableGate } from "./code-safety";
import { gateFix } from "./activation-steps";

/**
 * Pure view rules for the three owner safety controls on Settings → Activation.
 *
 * Backend facts these rules describe (they never change them):
 * - Kill Switch = `automation_policy.paused`. Turning it ON (stopJackboyWork) also engages the CODE
 *   Emergency Stop, because CODE runner/provider admission checks the Emergency Stop, not the Kill
 *   Switch. Turning it OFF (resumeJackboyWork) never touches CODE.
 * - CODE enabled and CODE Emergency Stop are separate columns but move together: only
 *   `enable_code_runtime` turns CODE on, and it releases the stop in the same locked step after every
 *   gate passes. Engaging the stop always turns CODE off. There is no separate "release" path.
 * Unknown state always reads as blocked; nothing here can make a control look usable when it is not.
 */
export type SafetyControlsInput = {
  /** Live `automation_policy.paused`; null when unreadable. */
  globalPaused: boolean | null;
  /** Live CODE runtime row; null when unreadable. */
  code: {
    enabled: boolean;
    killSwitch: boolean;
    activeRequestId: string | null;
    activeRunId: string | number | null;
  } | null;
  /** Server on-switch gates; null when they could not be read. */
  gates: CodeEnableGate[] | null;
};

export type UnmetRequirement = { id: string; label: string; detail: string; fix: string };

export type SafetyControlsView = {
  killSwitch: {
    status: "on" | "off" | "unknown";
    canToggle: boolean;
    lockReason: string | null;
    effect: string;
  };
  code: {
    status: "on" | "off" | "unknown";
    canTurnOn: boolean;
    canTurnOff: boolean;
    unmet: UnmetRequirement[];
    lockReason: string | null;
    effect: string;
  };
  emergencyStop: {
    status: "engaged" | "released" | "unknown";
    canEngage: boolean;
    lockReason: string | null;
    effect: string;
  };
  /** Whether CODE work may start right now according to the live reads. */
  execution: { allowed: boolean; blockedBy: string[] };
};

const KILL_FIX =
  "Use \"Turn Kill Switch off\" in control 1 and confirm with your passkey. Leave it on to keep all work paused.";
const KILL_ON_EFFECT =
  "All Jackboy work is paused. Turning it on also engages the CODE Emergency Stop (so CODE turns off too). Turning it off does NOT turn CODE back on.";
const KILL_OFF_EFFECT =
  "Jackboy work may run. Turning it on pauses all work and also engages the CODE Emergency Stop, which turns CODE off.";

export function safetyControlsView(input: SafetyControlsInput): SafetyControlsView {
  const { globalPaused, code, gates } = input;

  const killStatus = globalPaused === null ? "unknown" : globalPaused ? "on" : "off";
  const killSwitch = {
    status: killStatus,
    canToggle: globalPaused !== null,
    lockReason:
      globalPaused === null
        ? "The Kill Switch state could not be read. It cannot be changed until a fresh read succeeds."
        : null,
    effect: globalPaused === false ? KILL_OFF_EFFECT : KILL_ON_EFFECT,
  } as const;

  const codeOn = code !== null && code.enabled === true && code.killSwitch === false;
  const codeStatus = code === null ? "unknown" : codeOn ? "on" : "off";

  // A CODE that is already on has nothing to "turn on"; the "stopped" gate is expected to fail then.
  let unmet: UnmetRequirement[] = [];
  if (!codeOn) {
    if (code === null) {
      unmet.push({ id: "state", label: "CODE state readable", detail: "The CODE switch state could not be read.", fix: "Press Refresh. Nothing can be turned on until the state reads again." });
    }
    if (gates === null) {
      unmet.push({ id: "gates", label: "Requirement checks readable", detail: "The server's requirement checks could not be read.", fix: "Press Refresh. Missing checks never count as passed." });
    } else {
      unmet = unmet.concat(
        gates.filter((g) => !g.ok).map((g) =>
          g.id === "global_pause"
            ? { id: g.id, label: "Kill Switch is off", detail: globalPaused === null ? "Kill Switch state unreadable." : "The Kill Switch is on.", fix: KILL_FIX }
            : { id: g.id, label: g.label, detail: g.detail, fix: gateFix(g.id) },
        ),
      );
      if (gates.length === 0) {
        unmet.push({ id: "gates", label: "Requirement checks reported", detail: "The server reported no checks.", fix: "Press Refresh. Missing checks never count as passed." });
      }
    }
    // The Kill Switch read is authoritative here even if a gate list was read slightly earlier.
    if (globalPaused !== false && !unmet.some((u) => u.id === "global_pause")) {
      unmet.unshift({
        id: "global_pause",
        label: "Kill Switch is off",
        detail: globalPaused === null ? "Kill Switch state unreadable." : "The Kill Switch is on.",
        fix: KILL_FIX,
      });
    }
    // Lead with the Kill Switch so the first reason matches the first control on screen.
    unmet.sort((a, b) => Number(b.id === "global_pause") - Number(a.id === "global_pause"));
  }
  const canTurnOn = codeStatus === "off" && unmet.length === 0;
  const codeView = {
    status: codeStatus,
    canTurnOn,
    canTurnOff: codeOn,
    unmet,
    lockReason: codeOn
      ? null
      : unmet.length === 0
        ? null
        : unmet[0]?.id === "global_pause"
          ? `Locked: the Kill Switch is ${globalPaused === null ? "unreadable" : "on"}${unmet.length > 1 ? ` and ${unmet.length - 1} other requirement${unmet.length - 1 === 1 ? " is" : "s are"} not met` : ""}.`
          : `Locked: ${unmet.length} requirement${unmet.length === 1 ? " is" : "s are"} not met.`,
    effect: codeOn
      ? "CODE may start supervised tasks. Each run still waits for your approval in GitHub. Turning CODE off engages the Emergency Stop."
      : "CODE cannot start any task. Turning it on needs a new passkey and releases the Emergency Stop in the same step, only if every requirement passes.",
  } as const;

  const stopStatus = code === null ? "unknown" : code.killSwitch ? "engaged" : "released";
  // Engaging is the safe direction: allowed whenever it is not already engaged, including when the
  // state is unreadable or CODE is already disabled.
  const emergencyStop = {
    status: stopStatus,
    canEngage: stopStatus !== "engaged",
    lockReason: stopStatus === "engaged" ? "Already engaged." : null,
    effect:
      stopStatus === "engaged"
        ? "CODE is blocked and any running CODE job was asked to cancel. It is released only by turning CODE on with a new passkey after every requirement passes; there is no separate release button."
        : "Engaging it turns CODE off at once and asks GitHub to cancel any running CODE job. It can always be engaged.",
  } as const;

  const blockedBy: string[] = [];
  if (globalPaused !== false) blockedBy.push(globalPaused === null ? "Kill Switch state unreadable" : "Kill Switch is on");
  if (code === null) blockedBy.push("CODE state unreadable");
  else {
    if (code.killSwitch) blockedBy.push("CODE Emergency Stop is engaged");
    if (!code.enabled) blockedBy.push("CODE is off");
  }

  return {
    killSwitch,
    code: codeView,
    emergencyStop,
    execution: { allowed: blockedBy.length === 0, blockedBy },
  };
}

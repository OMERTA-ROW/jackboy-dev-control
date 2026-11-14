import type { CodeEnableGate } from "./code-safety";
import { gateFix } from "./activation-steps";

/**
 * Pure view rules for the three owner safety controls on Settings → Activation.
 *
 * Each control is its own saved setting with its own action; changing one never changes the other two:
 * - System Kill Switch = `automation_policy.paused`.
 * - Saved CODE setting = `code_runtime_controls.enabled` (set_code_enabled).
 * - CODE Emergency Stop = `code_runtime_controls.kill_switch` (engage_code_kill_switch / release_code_emergency_stop).
 * CODE can actually run only when the Kill Switch is off, the Emergency Stop is released, CODE is saved
 * as ON and every requirement passes. The database enforces that at every CODE start and AI call.
 *
 * `independent` says whether that database change is installed. Until it is (null/false), the old
 * coupled behaviour still applies (Kill Switch ON also engages the CODE stop, and the stop turns CODE
 * off), the new CODE and release actions are locked, and the Emergency Stop stays usable.
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
  /** Server requirements for turning the saved CODE setting on; null when unreadable. */
  gates: CodeEnableGate[] | null;
  /** Server requirements for releasing the Emergency Stop; null when unreadable. */
  releaseGates?: CodeEnableGate[] | null | undefined;
  /** True only when the database keeps the three controls separate. */
  independent?: boolean | null | undefined;
};

export type UnmetRequirement = { id: string; label: string; detail: string; fix: string };

export type SafetyControlsView = {
  independent: boolean;
  killSwitch: {
    status: "on" | "off" | "unknown";
    canToggle: boolean;
    lockReason: string | null;
    effect: string;
  };
  code: {
    /** The saved setting only, never combined with the other controls. */
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
    canRelease: boolean;
    releaseUnmet: UnmetRequirement[];
    lockReason: string | null;
    effect: string;
  };
  /** Whether CODE work may start right now according to the live reads (separate from the saved setting). */
  execution: { allowed: boolean; blockedBy: string[] };
};

export const NOT_INSTALLED_LOCK =
  "Locked: the database update that keeps CODE, the Emergency Stop and the Kill Switch separate is not installed yet (it waits for owner approval). The Emergency Stop still works.";

const unmetFrom = (gates: CodeEnableGate[] | null | undefined): UnmetRequirement[] => {
  if (!gates) return [{ id: "gates", label: "Requirement checks readable", detail: "The server's requirement checks could not be read.", fix: "Press Refresh. Missing checks never count as passed." }];
  if (gates.length === 0) return [{ id: "gates", label: "Requirement checks reported", detail: "The server reported no checks.", fix: "Press Refresh. Missing checks never count as passed." }];
  return gates.filter((g) => !g.ok).map((g) => ({ id: g.id, label: g.label, detail: g.detail, fix: gateFix(g.id) }));
};

const countText = (n: number) => `${n} requirement${n === 1 ? " is" : "s are"} not met`;

export function safetyControlsView(input: SafetyControlsInput): SafetyControlsView {
  const { globalPaused, code, gates } = input;
  const independent = input.independent === true;

  const killStatus = globalPaused === null ? "unknown" : globalPaused ? "on" : "off";
  const killSwitch = {
    status: killStatus,
    canToggle: globalPaused !== null,
    lockReason:
      globalPaused === null
        ? "The Kill Switch state could not be read. It cannot be changed until a fresh read succeeds."
        : null,
    effect: independent
      ? globalPaused === false
        ? "Jackboy work may run. Turning it on pauses all work and blocks every CODE start and AI call. It does not change the saved CODE setting or the Emergency Stop."
        : "All Jackboy work is paused and CODE cannot start or make AI calls. Turning it off does not turn CODE on or release the Emergency Stop."
      : globalPaused === false
        ? "Jackboy work may run. Turning it on pauses all work and, until the database update is installed, also engages the CODE Emergency Stop (which turns CODE off)."
        : "All Jackboy work is paused. Turning it off does NOT turn CODE back on or release the Emergency Stop.",
  } as const;

  const codeStatus = code === null ? "unknown" : code.enabled ? "on" : "off";
  let unmet: UnmetRequirement[] = [];
  if (codeStatus !== "on") {
    if (code === null) unmet.push({ id: "state", label: "CODE state readable", detail: "The CODE setting could not be read.", fix: "Press Refresh. Nothing can be turned on until the state reads again." });
    unmet = unmet.concat(unmetFrom(gates));
  }
  const codeView = {
    status: codeStatus,
    canTurnOn: independent && codeStatus === "off" && unmet.length === 0,
    canTurnOff: independent && codeStatus === "on",
    unmet,
    lockReason: !independent
      ? NOT_INSTALLED_LOCK
      : codeStatus === "unknown"
        ? "Locked: the CODE setting could not be read."
        : codeStatus === "off" && unmet.length > 0
          ? `Locked: ${countText(unmet.length)}.`
          : null,
    effect:
      codeStatus === "on"
        ? "Saved as ON. CODE runs only while the Kill Switch is off and the Emergency Stop is released. Turning it off needs a new passkey and never touches the other two controls."
        : "Saved as OFF. Turning it on needs a new passkey and every requirement. It does not release the Emergency Stop or change the Kill Switch.",
  } as const;

  const stopStatus = code === null ? "unknown" : code.killSwitch ? "engaged" : "released";
  const releaseUnmet = stopStatus === "engaged" ? unmetFrom(input.releaseGates) : [];
  const canRelease = independent && stopStatus === "engaged" && releaseUnmet.length === 0;
  // Engaging is the safe direction: allowed whenever it is not already engaged, including when the
  // state is unreadable, CODE is disabled or the Kill Switch is on.
  const emergencyStop = {
    status: stopStatus,
    canEngage: stopStatus !== "engaged",
    canRelease,
    releaseUnmet,
    lockReason:
      stopStatus !== "engaged"
        ? null
        : !independent
          ? NOT_INSTALLED_LOCK
          : releaseUnmet.length > 0
            ? `Release locked: ${countText(releaseUnmet.length)}.`
            : null,
    effect:
      stopStatus === "engaged"
        ? independent
          ? "CODE is blocked and any running CODE job was asked to cancel. Releasing it needs a new passkey and does not turn CODE on or change the Kill Switch."
          : "CODE is blocked and any running CODE job was asked to cancel. A separate release needs the database update first."
        : independent
          ? "Engaging it blocks CODE at once and asks GitHub to cancel any running CODE job. It keeps the saved CODE setting. It can always be engaged."
          : "Engaging it blocks CODE at once, asks GitHub to cancel any running CODE job and (until the database update) turns CODE off. It can always be engaged.",
  } as const;

  const blockedBy: string[] = [];
  if (!independent) blockedBy.push("Independent safety controls not verified");
  if (globalPaused !== false) blockedBy.push(globalPaused === null ? "Kill Switch state unreadable" : "Kill Switch is on");
  if (code === null) blockedBy.push("CODE state unreadable");
  else {
    if (code.killSwitch) blockedBy.push("CODE Emergency Stop is engaged");
    if (!code.enabled) blockedBy.push("CODE is saved as OFF");
  }
  // Requirements still apply even when all three controls allow work.
  for (const u of unmetFrom(gates)) blockedBy.push(u.label === "No CODE task is running" ? "A CODE task is already running" : `Not met: ${u.label}`);

  return {
    independent,
    killSwitch,
    code: codeView,
    emergencyStop,
    execution: { allowed: blockedBy.length === 0, blockedBy },
  };
}

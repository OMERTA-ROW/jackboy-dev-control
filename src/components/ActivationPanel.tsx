import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Circle, CircleDot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReadinessChecks } from "./ReadinessChecks";
import { CodeAcceptanceCard } from "./CodeAcceptanceCard";
import { UnifiedOmniStatus } from "./UnifiedOmniStatus";
import { SafetyControls } from "./SafetyControls";
import { safetyControlsView } from "@/lib/safety-controls";
import type { AcceptanceGates } from "@/lib/code-acceptance";
import { useStepUp } from "@/lib/step-up-client";
import {
  engageCodeKillSwitch,
  releaseCodeEmergencyStop,
  resumeJackboyWork,
  setCodeEnabled,
  setCodeHardCapVerified,
  stopJackboyWork,
} from "@/lib/code-safety.functions";
import {
  CODE_DISABLE_TARGET,
  CODE_ENABLE_TARGET,
  CODE_STOP_RELEASE_TARGET,
  HARD_CAP_EVIDENCE_MAX,
  HARD_CAP_TARGET,
  hardCapChangeBlockReason,
  type CodeEnableGate,
  type CodeSafetyState,
} from "@/lib/code-safety";
import {
  activationProgress,
  activationSteps,
  gateFix,
  type ActivationStep,
} from "@/lib/activation-steps";

export type ActivationState = {
  enabled: boolean;
  killSwitch: boolean;
  activeRequestId: string | null;
  activeRunId: string | null;
  providerBudgetEnforced: boolean;
  totalSpendGuard: CodeSafetyState["totalSpendGuard"];
};

type Props = {
  state: ActivationState | null;
  gates: CodeEnableGate[] | null;
  /** Server requirements for releasing the Emergency Stop; null when unreadable. */
  releaseGates?: CodeEnableGate[] | null;
  /** True only when the database keeps the three controls separate. */
  independent?: boolean | null;
  gatesError: string | null;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
  /** Live Kill Switch (global pause) state from the server; null when unreadable. */
  globalPaused?: boolean | null;
  /** Result of the last action pressed in this panel. */
  message?: string | null;
  /** Optional extra evidence shown under the readiness checks. */
  evidence?: ReactNode;
  /** Live gates for the one-time $1 acceptance test; null while loading. */
  acceptance?: AcceptanceGates | null;
  /** Tone of `message`: success, error or neutral information. */
  messageTone?: "success" | "error" | "info";
  /** ISO time of the last live safety read. */
  checkedAt?: string | null | undefined;
  /** Re-reads the live safety state and requirement checks. */
  onRefresh?: (() => void) | undefined;
};

/** One place for every CODE activation step, in order. All buttons call the same server functions with
 * the same passkey actions as before; the server and database re-check every gate. */
export function ActivationPanel({
  state,
  gates,
  releaseGates = null,
  independent = null,
  globalPaused = null,
  gatesError,
  busy,
  run,
  message,
  evidence,
  acceptance = null,
  messageTone = "info",
  checkedAt = null,
  onRefresh,
}: Props) {
  const stepUp = useStepUp();
  const stop = useServerFn(engageCodeKillSwitch);
  const resume = useServerFn(resumeJackboyWork);
  const pauseAll = useServerFn(stopJackboyWork);
  const setHardCap = useServerFn(setCodeHardCapVerified);
  const setEnabled = useServerFn(setCodeEnabled);
  const releaseStop = useServerFn(releaseCodeEmergencyStop);
  const [capNote, setCapNote] = useState("");
  const [guided, setGuided] = useState(false);
  const [justDone, setJustDone] = useState<string | null>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const lastIndex = useRef<number | null>(null);

  const steps = gates && state ? activationSteps(gates, state, globalPaused) : null;
  const progress = steps ? activationProgress(steps) : null;
  const currentIndex = steps ? steps.findIndex((step) => step.status !== "done") : -1;

  // Auto-advance only moves what is shown: when a fresh server read marks the step done, the next one
  // appears. It never presses a button; every change still needs the owner's own press and passkey.
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  useEffect(() => {
    const steps = stepsRef.current;
    if (!guided || !steps) return;
    const previous = lastIndex.current;
    if (previous !== null && currentIndex !== previous) {
      const finished = previous >= 0 ? steps[previous] : undefined;
      setJustDone(
        finished && finished.status === "done" && (currentIndex > previous || currentIndex === -1)
          ? `Step ${previous + 1} done: ${finished.title}.`
          : null,
      );
    }
    lastIndex.current = currentIndex;
    stepHeading.current?.focus();
  }, [guided, currentIndex]);

  const startGuide = () => {
    lastIndex.current = null;
    setJustDone(null);
    setGuided(true);
  };
  const exitGuide = () => {
    setGuided(false);
    setJustDone(null);
  };
  const checkAgain = () => void run(async () => undefined);

  const engageStop = () =>
    void run(() =>
      stepUp("global_pause", "global_pause:on", {
        applyingText: "Engaging the CODE emergency stop…",
        apply: (grantId) => stop({ data: { grantId } }),
        doneText: (result) =>
          result.omniCancellation.unavailable
            ? "CODE emergency stop engaged; OMNI cancellation is unverified. New executions are blocked."
            : "CODE emergency stop engaged; OMNI cancellation confirmed or no OMNI jobs pending.",
      }),
    );
  const turnKillSwitchOff = () =>
    void run(() =>
      stepUp("global_pause", "global_pause:off", {
        applyingText: "Turning the Kill Switch off…",
        apply: (grantId) => resume({ data: { grantId } }),
        doneText: () => "Kill Switch is off. CODE was not changed.",
      }),
    );
  const turnKillSwitchOn = () =>
    void run(() =>
      stepUp("global_pause", "global_pause:on", {
        applyingText: "Turning the Kill Switch on…",
        apply: (grantId) => pauseAll({ data: { grantId } }),
        doneText: (r) => `Kill Switch is on. ${r.warning}`,
      }),
    );
  const turnCodeOn = () =>
    void run(() =>
      stepUp("code_enable", CODE_ENABLE_TARGET, {
        applyingText: "Re-checking every requirement and saving CODE as ON…",
        apply: (grantId) => setEnabled({ data: { grantId, enabled: true } }),
        doneText: (r) => r.message,
      }),
    );
  const turnCodeOff = () =>
    void run(() =>
      stepUp("code_enable", CODE_DISABLE_TARGET, {
        applyingText: "Saving CODE as OFF…",
        apply: (grantId) => setEnabled({ data: { grantId, enabled: false } }),
        doneText: (r) => r.message,
      }),
    );
  const releaseEmergencyStop = () =>
    void run(() =>
      stepUp("code_stop_release", CODE_STOP_RELEASE_TARGET, {
        applyingText: "Re-checking the emergency protections and releasing the Emergency Stop…",
        apply: (grantId) => releaseStop({ data: { grantId } }),
        doneText: (r) => r.message,
      }),
    );

  const view = safetyControlsView({ globalPaused, code: state, gates, releaseGates, independent });
  const safetyControls = (
    <>
      <UnifiedOmniStatus />
      <SafetyControls
        view={view}
        busy={busy}
        onKillSwitchOn={turnKillSwitchOn}
        onKillSwitchOff={turnKillSwitchOff}
        onCodeOn={turnCodeOn}
        onCodeOff={turnCodeOff}
        onEngageStop={engageStop}
        onReleaseStop={releaseEmergencyStop}
        checkedAt={checkedAt}
        onRefresh={onRefresh}
      />
    </>
  );

  const control = (step: ActivationStep): ReactNode => {
    if (!state) return null;
    if (step.id === "hard_cap") {
      const marking = !state.providerBudgetEnforced;
      const blocked = hardCapChangeBlockReason({
        verified: marking,
        evidence: capNote,
        current: state,
      });
      const stateBlocked = hardCapChangeBlockReason({
        verified: marking,
        evidence: "evidence-ok",
        current: state,
      });
      const form = (
        <div className="mt-2">
          <label htmlFor="hard-cap-note" className="block text-xs text-muted-foreground">
            Evidence note (what you checked, where and when)
          </label>
          <textarea
            id="hard-cap-note"
            value={capNote}
            maxLength={HARD_CAP_EVIDENCE_MAX}
            rows={2}
            onChange={(event) => setCapNote(event.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
          {blocked && (capNote.trim().length > 0 || stateBlocked) && (
            <p className="mt-1 text-xs text-warning">{stateBlocked ?? blocked}</p>
          )}
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={busy || blocked !== null}
            onClick={() =>
              void run(async () => {
                const result = await stepUp(
                  "code_hard_cap",
                  marking ? HARD_CAP_TARGET.mark : HARD_CAP_TARGET.unmark,
                  {
                    applyingText: marking
                      ? "Marking the hard cap verified…"
                      : "Un-marking the hard cap…",
                    apply: (grantId) =>
                      setHardCap({
                        data: { grantId, verified: marking, evidence: capNote.trim() },
                      }),
                    doneText: () => (marking ? "Hard cap marked verified." : "Hard cap un-marked."),
                  },
                );
                setCapNote("");
                return result;
              })
            }
          >
            {marking ? "Mark hard cap verified with passkey" : "Un-mark hard cap with passkey"}
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">
            Needs a new passkey every time. Works only while CODE is off and the Emergency Stop is
            on.
          </p>
        </div>
      );
      return marking ? (
        form
      ) : (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Un-mark the hard cap</summary>
          {form}
        </details>
      );
    }
    if (step.id === "global_pause" && step.status !== "done") {
      return globalPaused === true ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          disabled={busy || step.status !== "current"}
          onClick={turnKillSwitchOff}
        >
          Turn Kill Switch off with passkey
        </Button>
      ) : null;
    }
    if (step.id === "release_stop" && step.status !== "done") {
      return (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          disabled={busy || !view.emergencyStop.canRelease}
          onClick={releaseEmergencyStop}
        >
          Release emergency stop with passkey
        </Button>
      );
    }
    if (step.id === "turn_on" && step.status !== "done") {
      return (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          disabled={busy || !view.code.canTurnOn}
          onClick={turnCodeOn}
        >
          Turn CODE on with passkey
        </Button>
      );
    }
    return null;
  };

  const stepList = (
    <ol className="mt-3 space-y-3" aria-label="Activation steps">
      {steps?.map((step, index) => (
        <li
          key={step.id}
          className="flex gap-3"
          aria-current={step.status === "current" ? "step" : undefined}
        >
          <span
            className={
              step.status === "done"
                ? "text-success"
                : step.status === "current"
                  ? "text-accent"
                  : "text-muted-foreground"
            }
            aria-hidden="true"
          >
            {step.status === "done" ? (
              <Check className="size-5" />
            ) : step.status === "current" ? (
              <CircleDot className="size-5" />
            ) : (
              <Circle className="size-5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {index + 1}. {step.title}{" "}
              <span
                className={`text-xs font-normal ${step.status === "done" ? "text-success" : step.status === "current" ? "text-warning" : "text-muted-foreground"}`}
              >
                {step.status === "done"
                  ? "Done"
                  : step.status === "current"
                    ? "Needs you now"
                    : "Waiting on an earlier step"}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">{step.hint}</p>
            <ul className="mt-1 space-y-0.5 text-xs" aria-label={`${step.title} checks`}>
              {step.gates.map((gate) => (
                <li key={gate.id} className={gate.ok ? "text-muted-foreground" : "text-warning"}>
                  <span aria-hidden="true">{gate.ok ? "✓" : "✗"}</span>{" "}
                  <span className="sr-only">{gate.ok ? "Passed:" : "Not passed:"}</span>
                  {`${gate.label} — ${gate.detail}`}
                </li>
              ))}
            </ul>
            {control(step)}
          </div>
        </li>
      ))}
    </ol>
  );

  const guideStep = steps && currentIndex >= 0 ? steps[currentIndex] : null;
  const guideAction = guideStep ? control(guideStep) : null;
  const guide = (
    <div className="mt-3 rounded-md border border-border p-4" aria-label="Activation walkthrough">
      {justDone && (
        <p role="status" className="mb-3 flex items-center gap-2 text-sm text-success">
          <Check className="size-4" aria-hidden /> {justDone}
        </p>
      )}
      {!justDone && steps && currentIndex > 0 && (
        <p className="mb-3 flex items-center gap-2 text-sm text-success">
          <Check className="size-4" aria-hidden />
          {currentIndex === 1 ? "Step 1 is" : `Steps 1–${currentIndex} are`} already done.
        </p>
      )}
      {!steps ? (
        <p className="text-sm text-muted-foreground">Checking each step…</p>
      ) : !guideStep ? (
        <div>
          <h3
            ref={stepHeading}
            tabIndex={-1}
            className="text-base font-semibold text-success outline-none"
          >
            Activation complete
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Live check: CODE is on, its stop is released and the Kill Switch is off. Jackboy can now
            start supervised CODE tasks; each run still waits for your approval in GitHub. The
            controls above stop it at once.
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={exitGuide}>
            Close walkthrough
          </Button>
        </div>
      ) : (
        <div>
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Step {currentIndex + 1} of {steps.length}
          </p>
          <div className="mt-1 h-1 w-full overflow-hidden rounded bg-muted" aria-hidden="true">
            <div
              className="h-full bg-primary"
              style={{ width: `${(currentIndex / steps.length) * 100}%` }}
            />
          </div>
          <h3 ref={stepHeading} tabIndex={-1} className="mt-3 text-base font-semibold outline-none">
            {guideStep.title}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">{guideStep.hint}</p>
          {(() => {
            const failing = guideStep.gates.filter((gate) => !gate.ok);
            const controlLock =
              guideStep.id === "release_stop"
                ? view.emergencyStop.lockReason
                : guideStep.id === "turn_on"
                  ? view.code.lockReason
                  : null;
            const waitingOnYou =
              guideStep.id === "hard_cap" ||
              (guideStep.id === "global_pause" && guideAction !== null) ||
              (guideStep.id === "release_stop" && view.emergencyStop.canRelease) ||
              (guideStep.id === "turn_on" && view.code.canTurnOn);
            if (waitingOnYou)
              return (
                <p className="mt-3 text-sm">
                  <span className="font-medium text-warning">Status: ready for you.</span>{" "}
                  {guideStep.id === "turn_on" || guideStep.id === "release_stop"
                    ? "Every check passes. This is your choice; nothing happens until you press."
                    : gateFix(guideStep.gates[0]?.id ?? "")}
                </p>
              );
            return (
              <div className="mt-3 text-sm" role="alert">
                <p className="font-medium text-warning">Status: blocked</p>
                {controlLock && <p className="mt-1">Why: {controlLock}</p>}
                <ul className="mt-1 space-y-2">
                  {failing.map((gate) => (
                    <li key={gate.id}>
                      <p>Why: {gate.detail || gate.label}</p>
                      <p className="text-muted-foreground">How to fix: {gateFix(gate.id)}</p>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}
          <div className="mt-3">
            {guideAction ?? (
              <Button variant="outline" size="sm" disabled={busy} onClick={checkAgain}>
                Check again
              </Button>
            )}
          </div>
        </div>
      )}
      <div className="mt-4 border-t border-border pt-3">
        <Button variant="ghost" size="sm" onClick={exitGuide}>
          Exit walkthrough and show all steps
        </Button>
      </div>
    </div>
  );

  return (
    <section
      id="activation"
      className="panel mb-4 scroll-mt-20 p-4"
      aria-labelledby="activation-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="activation-heading"
            className="text-sm font-semibold uppercase tracking-wider text-silver"
          >
            Autonomous Activation
          </h2>
          <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
            {!progress
              ? "Checking each step…"
              : progress.complete
                ? "Activation complete · CODE is on. Each run still needs your approval in GitHub."
                : `${progress.done} of ${progress.total} steps done · CODE cannot run yet. Three separate controls below: Kill Switch, CODE enabled and CODE Emergency Stop.`}
          </p>
        </div>
      </div>
      {safetyControls}
      {message && (
        <p
          role={messageTone === "error" ? "alert" : "status"}
          className={`mt-3 text-sm ${messageTone === "error" ? "text-destructive" : messageTone === "success" ? "text-success" : "text-warning"}`}
        >
          {messageTone === "error" ? "Not done: " : messageTone === "success" ? "Done: " : ""}
          {message}
        </p>
      )}
      {gatesError && (
        <p role="alert" className="mt-2 text-xs text-warning">
          {gatesError}
        </p>
      )}
      {!guided && steps && !progress?.complete && (
        <Button size="sm" className="mt-3" onClick={startGuide}>
          Start activation
        </Button>
      )}
      {guided
        ? guide
        : steps &&
          (progress?.complete ? (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-muted-foreground">
                Show activation steps
              </summary>
              {stepList}
            </details>
          ) : (
            stepList
          ))}
      {progress?.complete && acceptance && <CodeAcceptanceCard gates={acceptance} />}
      <details className="mt-4 border-t border-border pt-3" open={!progress?.complete}>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Readiness checks and tests
        </summary>
        <div className="mt-2">
          <ReadinessChecks
            busy={busy}
            emergencyStopEngaged={state?.killSwitch !== false}
            onEmergencyStop={engageStop}
            onStartActivation={() => {
              startGuide();
              document
                .getElementById("activation")
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          />
          {evidence}
        </div>
      </details>
    </section>
  );
}

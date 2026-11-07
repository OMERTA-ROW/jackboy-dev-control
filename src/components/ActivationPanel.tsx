import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Circle, CircleDot, OctagonX, Power } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ReadinessChecks } from "./ReadinessChecks";
import { useStepUp } from "@/lib/step-up-client";
import {
  enableCodeRuntime,
  engageCodeKillSwitch,
  resumeJackboyWork,
  setCodeHardCapVerified,
  stopJackboyWork,
} from "@/lib/code-safety.functions";
import {
  CODE_ENABLE_TARGET,
  HARD_CAP_EVIDENCE_MAX,
  HARD_CAP_TARGET,
  hardCapChangeBlockReason,
  type CodeEnableGate,
  type CodeSafetyState,
} from "@/lib/code-safety";
import {
  activationProgress,
  activationSteps,
  codeIsOn,
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
  gatesError: string | null;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
  /** Live Kill Switch (global pause) state from the server; null when unreadable. */
  globalPaused?: boolean | null;
  /** Result of the last action pressed in this panel. */
  message?: string | null;
  /** Dated background evidence, shown folded at the bottom. */
  evidence?: ReactNode;
};

/** One place for every CODE activation step, in order. All buttons call the same server functions with
 * the same passkey actions as before; the server and database re-check every gate. */
export function ActivationPanel({
  state,
  gates,
  globalPaused = null,
  gatesError,
  busy,
  run,
  message,
  evidence,
}: Props) {
  const stepUp = useStepUp();
  const stop = useServerFn(engageCodeKillSwitch);
  const resume = useServerFn(resumeJackboyWork);
  const pauseAll = useServerFn(stopJackboyWork);
  const setHardCap = useServerFn(setCodeHardCapVerified);
  const enableCode = useServerFn(enableCodeRuntime);
  const [capNote, setCapNote] = useState("");
  const [guided, setGuided] = useState(false);
  const [justDone, setJustDone] = useState<string | null>(null);
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const lastIndex = useRef<number | null>(null);

  const steps = gates && state ? activationSteps(gates, state) : null;
  const progress = steps ? activationProgress(steps) : null;
  const on = state ? codeIsOn(state) : false;
  const allGatesPass = !!gates && gates.every((gate) => gate.ok);
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

  const emergencyStop = (
    <Button
      variant="destructive"
      size="sm"
      disabled={busy || !state || state.killSwitch}
      onClick={() =>
        void run(() =>
          stepUp("global_pause", "global_pause:on").then((grantId) => stop({ data: { grantId } })),
        )
      }
    >
      <OctagonX aria-hidden />
      {state?.killSwitch ? "Emergency stop engaged" : "Engage emergency stop"}
    </Button>
  );

  // Same passkey actions and server functions the Home bar used; the server re-checks each grant.
  const killSwitch = (
    <Button
      variant="outline"
      size="sm"
      disabled={busy || globalPaused === null}
      aria-pressed={globalPaused === true}
      onClick={() =>
        void run(() =>
          globalPaused
            ? stepUp("global_pause", "global_pause:off").then((grantId) =>
                resume({ data: { grantId } }),
              )
            : stepUp("global_pause", "global_pause:on").then((grantId) =>
                pauseAll({ data: { grantId } }),
              ),
        )
      }
    >
      <Power aria-hidden />
      {globalPaused ? "Turn Kill Switch off" : "Turn Kill Switch on"}
    </Button>
  );

  const safetyControls = (
    <div
      className="mt-3 grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2"
      aria-label="Pause and stop controls"
    >
      <div>
        <p className="text-sm font-medium">
          Kill Switch:{" "}
          <span
            className={globalPaused === false ? "text-success" : "text-warning"}
            aria-live="polite"
          >
            {globalPaused === null ? "unknown" : globalPaused ? "on — all work paused" : "off"}
          </span>
        </p>
        <p className="mb-2 text-xs text-muted-foreground">
          Pauses or resumes all Jackboy work. Needs your passkey.
        </p>
        {killSwitch}
      </div>
      <div>
        <p className="text-sm font-medium">
          CODE emergency stop:{" "}
          <span
            className={state?.killSwitch === false ? "text-success" : "text-warning"}
            aria-live="polite"
          >
            {!state ? "unknown" : state.killSwitch ? "engaged — CODE off" : "released"}
          </span>
        </p>
        <p className="mb-2 text-xs text-muted-foreground">
          Turns CODE off at once and cancels a running job. Never blocked.
        </p>
        {emergencyStop}
      </div>
    </div>
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
                const grantId = await stepUp(
                  "code_hard_cap",
                  marking ? HARD_CAP_TARGET.mark : HARD_CAP_TARGET.unmark,
                );
                const result = await setHardCap({
                  data: { grantId, verified: marking, evidence: capNote.trim() },
                });
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
          onClick={() =>
            void run(() =>
              stepUp("global_pause", "global_pause:off").then((grantId) =>
                resume({ data: { grantId } }),
              ),
            )
          }
        >
          Turn Kill Switch off with passkey
        </Button>
      ) : null;
    }
    if (step.id === "turn_on" && !on) {
      return (
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          disabled={busy || !allGatesPass}
          onClick={() =>
            void run(() =>
              stepUp("code_enable", CODE_ENABLE_TARGET).then((grantId) =>
                enableCode({ data: { grantId } }),
              ),
            )
          }
        >
          Release CODE stop and turn CODE on with passkey
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
                <li
                  key={gate.id}
                  className={
                    gate.ok || (step.id === "turn_on" && on)
                      ? "text-muted-foreground"
                      : "text-warning"
                  }
                >
                  <span aria-hidden="true">
                    {gate.ok || (step.id === "turn_on" && on) ? "✓" : "✗"}
                  </span>{" "}
                  <span className="sr-only">{gate.ok ? "Passed:" : "Not passed:"}</span>
                  {step.id === "turn_on" && on
                    ? "CODE is on and its stop is released."
                    : `${gate.label} — ${gate.detail}`}
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
            const waitingOnYou =
              guideStep.id === "hard_cap" ||
              (guideStep.id === "global_pause" && guideAction !== null) ||
              (guideStep.id === "turn_on" && failing.length === 0);
            if (waitingOnYou)
              return (
                <p className="mt-3 text-sm">
                  <span className="font-medium text-warning">Status: ready for you.</span>{" "}
                  {guideStep.id === "turn_on"
                    ? "Every check passes. Turning CODE on is your choice; nothing happens until you press."
                    : gateFix(guideStep.gates[0]?.id ?? "")}
                </p>
              );
            return (
              <div className="mt-3 text-sm" role="alert">
                <p className="font-medium text-warning">Status: blocked</p>
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
                : `${progress.done} of ${progress.total} steps done · CODE is off.`}
          </p>
        </div>
      </div>
      {safetyControls}
      {message && (
        <p role="status" className="mt-3 text-sm text-warning">
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
      {evidence && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Dated background evidence
          </summary>
          {evidence}
        </details>
      )}
    </section>
  );
}

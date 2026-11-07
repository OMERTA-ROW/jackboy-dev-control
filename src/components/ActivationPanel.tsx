import { useServerFn } from "@tanstack/react-start";
import { useState, type ReactNode } from "react";
import { Check, Circle, CircleDot, OctagonX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStepUp } from "@/lib/step-up-client";
import {
  enableCodeRuntime,
  engageCodeKillSwitch,
  resumeJackboyWork,
  setCodeHardCapVerified,
} from "@/lib/code-safety.functions";
import {
  CODE_ENABLE_TARGET,
  HARD_CAP_EVIDENCE_MAX,
  HARD_CAP_TARGET,
  hardCapChangeBlockReason,
  type CodeEnableGate,
  type CodeSafetyState,
} from "@/lib/code-safety";
import { activationProgress, activationSteps, codeIsOn, type ActivationStep } from "@/lib/activation-steps";

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
  /** Result of the last action pressed in this panel. */
  message?: string | null;
  /** Dated background evidence, shown folded at the bottom. */
  evidence?: ReactNode;
};

/** One place for every CODE activation step, in order. All buttons call the same server functions with
 * the same passkey actions as before; the server and database re-check every gate. */
export function ActivationPanel({ state, gates, gatesError, busy, run, message, evidence }: Props) {
  const stepUp = useStepUp();
  const stop = useServerFn(engageCodeKillSwitch);
  const resume = useServerFn(resumeJackboyWork);
  const setHardCap = useServerFn(setCodeHardCapVerified);
  const enableCode = useServerFn(enableCodeRuntime);
  const [capNote, setCapNote] = useState("");

  const steps = gates && state ? activationSteps(gates, state) : null;
  const progress = steps ? activationProgress(steps) : null;
  const on = state ? codeIsOn(state) : false;
  const allGatesPass = !!gates && gates.every((gate) => gate.ok);

  const emergencyStop = (
    <Button variant="destructive" size="sm"
      disabled={busy || !state || state.killSwitch}
      onClick={() => void run(() => stepUp("global_pause", "global_pause:on").then((grantId) => stop({ data: { grantId } })))}
    >
      <OctagonX aria-hidden />
      {state?.killSwitch ? "Emergency stop engaged" : "Engage emergency stop"}
    </Button>
  );

  const control = (step: ActivationStep): ReactNode => {
    if (!state) return null;
    if (step.id === "hard_cap") {
      const marking = !state.providerBudgetEnforced;
      const blocked = hardCapChangeBlockReason({ verified: marking, evidence: capNote, current: state });
      const stateBlocked = hardCapChangeBlockReason({ verified: marking, evidence: "evidence-ok", current: state });
      const form = (
        <div className="mt-2">
          <label htmlFor="hard-cap-note" className="block text-xs text-muted-foreground">
            Evidence note (what you checked, where and when)
          </label>
          <textarea id="hard-cap-note" value={capNote} maxLength={HARD_CAP_EVIDENCE_MAX} rows={2}
            onChange={(event) => setCapNote(event.target.value)}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
          {blocked && (capNote.trim().length > 0 || stateBlocked) && (
            <p className="mt-1 text-xs text-warning">{stateBlocked ?? blocked}</p>
          )}
          <Button variant="outline" size="sm" className="mt-2"
            disabled={busy || blocked !== null}
            onClick={() => void run(async () => {
              const grantId = await stepUp("code_hard_cap", marking ? HARD_CAP_TARGET.mark : HARD_CAP_TARGET.unmark);
              const result = await setHardCap({ data: { grantId, verified: marking, evidence: capNote.trim() } });
              setCapNote("");
              return result;
            })}
          >
            {marking ? "Mark hard cap verified with passkey" : "Un-mark hard cap with passkey"}
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">Needs a new passkey every time. Works only while CODE is off and the Emergency Stop is on.</p>
        </div>
      );
      return marking ? form : (
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Un-mark the hard cap</summary>
          {form}
        </details>
      );
    }
    if (step.id === "global_pause" && step.status !== "done") {
      const paused = step.gates[0]?.detail.startsWith("Turn the global pause off") === true;
      return paused ? (
        <Button variant="outline" size="sm" className="mt-2"
          disabled={busy || step.status !== "current"}
          onClick={() => void run(() => stepUp("global_pause", "global_pause:off").then((grantId) => resume({ data: { grantId } })))}
        >
          Turn global pause off with passkey
        </Button>
      ) : null;
    }
    if (step.id === "turn_on" && !on) {
      return (
        <Button variant="outline" size="sm" className="mt-2"
          disabled={busy || !allGatesPass}
          onClick={() => void run(() => stepUp("code_enable", CODE_ENABLE_TARGET).then((grantId) => enableCode({ data: { grantId } })))}
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
        <li key={step.id} className="flex gap-3" aria-current={step.status === "current" ? "step" : undefined}>
          <span className={step.status === "done" ? "text-success" : step.status === "current" ? "text-accent" : "text-muted-foreground"} aria-hidden="true">
            {step.status === "done" ? <Check className="size-5" /> : step.status === "current" ? <CircleDot className="size-5" /> : <Circle className="size-5" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {index + 1}. {step.title}{" "}
              <span className={`text-xs font-normal ${step.status === "done" ? "text-success" : step.status === "current" ? "text-warning" : "text-muted-foreground"}`}>
                {step.status === "done" ? "Done" : step.status === "current" ? "Needs you now" : "Waiting on an earlier step"}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">{step.hint}</p>
            <ul className="mt-1 space-y-0.5 text-xs" aria-label={`${step.title} checks`}>
              {step.gates.map((gate) => (
                <li key={gate.id} className={gate.ok || (step.id === "turn_on" && on) ? "text-muted-foreground" : "text-warning"}>
                  <span aria-hidden="true">{gate.ok || (step.id === "turn_on" && on) ? "✓" : "✗"}</span>{" "}
                  <span className="sr-only">{gate.ok ? "Passed:" : "Not passed:"}</span>
                  {step.id === "turn_on" && on ? "CODE is on and its stop is released." : `${gate.label} — ${gate.detail}`}
                </li>
              ))}
            </ul>
            {control(step)}
          </div>
        </li>
      ))}
    </ol>
  );

  return (
    <section id="activation" className="panel mb-4 scroll-mt-20 p-4" aria-labelledby="activation-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="activation-heading" className="text-sm font-semibold uppercase tracking-wider text-silver">
            CODE activation
          </h2>
          <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
            {!progress ? "Checking each step…" : progress.complete
              ? "Activation complete · CODE is on. Each run still needs your approval in GitHub."
              : `${progress.done} of ${progress.total} steps done · CODE is off.`}
          </p>
        </div>
        {emergencyStop}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        The emergency stop turns CODE off at once and is never blocked. The Kill Switch on Home pauses all Jackboy work.
      </p>
      {message && <p role="status" className="mt-3 text-sm text-warning">{message}</p>}
      {gatesError && <p role="alert" className="mt-2 text-xs text-warning">{gatesError}</p>}
      {steps && (progress?.complete ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">Show activation steps</summary>
          {stepList}
        </details>
      ) : stepList)}
      {evidence && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">Dated background evidence</summary>
          {evidence}
        </details>
      )}
    </section>
  );
}

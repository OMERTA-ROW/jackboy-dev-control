// Browser side of passkey step-up: asks the device for a passkey (Face ID / Touch ID / Windows Hello /
// password manager / phone) for one exact action + target and returns a single-use, 5-minute grant id.
// Every call opens the shared passkey window and a real device check; nothing is skipped silently.
// With `apply`, the same window also runs the change that uses the grant and shows its real outcome.
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { stepUpOptions, stepUpVerify } from "./passkey.functions";
import { requestPasskey } from "./passkey-prompt";
import { STEP_UP_ACTIONS } from "./step-up";

export type StepUpOptions<R> = {
  apply: (grantId: string) => Promise<R>;
  /** Shown while the change runs, e.g. "Turning the Kill Switch off…". */
  applyingText?: string;
  /** Shown when the change succeeded. */
  doneText?: (result: R) => string;
  /** e.g. "Passkey 2 of 3 · OMNI". */
  step?: string;
};

export type StepUp = {
  (action: string, target: string): Promise<string>;
  <R>(action: string, target: string, opts: StepUpOptions<R>): Promise<R>;
};

export function useStepUp(): StepUp {
  const opts = useServerFn(stepUpOptions), verify = useServerFn(stepUpVerify);
  return useCallback(async (action: string, target: string, o?: StepUpOptions<unknown>) => {
    const label = (STEP_UP_ACTIONS as Record<string, { label: string }>)[action]?.label ?? "Confirm this action";
    const base = {
      title: "Confirm with your passkey",
      description: label,
      step: o?.step,
      prepare: async () => {
        const x = await opts({ data: { action, target } });
        return { kind: "auth" as const, challengeId: x.challengeId, options: x.options, keys: x.keys };
      },
      finish: (challengeId: string, response: unknown) => verify({ data: { challengeId, response } }),
    };
    if (!o) {
      const g = await requestPasskey<{ grantId: string; expiresAt: string }>({ ...base, successText: () => "Passkey confirmed." });
      return g.grantId;
    }
    return requestPasskey<{ grantId: string; expiresAt: string }, unknown>({
      ...base,
      apply: (g) => o.apply(g.grantId),
      applyingText: o.applyingText ?? "Passkey confirmed. Making the change…",
      successText: (r) => o.doneText?.(r) ?? "Done.",
    });
  }, [opts, verify]) as StepUp;
}

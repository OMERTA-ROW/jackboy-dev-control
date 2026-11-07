// Browser side of passkey step-up: asks the device for a passkey (Face ID / Touch ID / security key)
// for one exact action + target and returns a single-use, 5-minute grant id.
// Every call opens the shared passkey window and a real device check; nothing is skipped silently.
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { stepUpOptions, stepUpVerify } from "./passkey.functions";
import { requestPasskey } from "./passkey-prompt";
import { STEP_UP_ACTIONS } from "./step-up";

export function useStepUp() {
  const opts = useServerFn(stepUpOptions), verify = useServerFn(stepUpVerify);
  return useCallback(async (action: string, target: string) => {
    const label = (STEP_UP_ACTIONS as Record<string, { label: string }>)[action]?.label ?? "Confirm this action";
    const g = await requestPasskey({
      title: "Confirm with your passkey",
      description: label,
      prepare: async () => {
        const o = await opts({ data: { action, target } });
        return { kind: "auth", challengeId: o.challengeId, options: o.options };
      },
      finish: (challengeId, response) => verify({ data: { challengeId, response } }),
      successText: () => "Passkey confirmed.",
    });
    return g.grantId;
  }, [opts, verify]);
}

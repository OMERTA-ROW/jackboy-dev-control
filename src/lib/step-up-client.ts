// Browser side of passkey step-up: asks the device for a passkey (Face ID / Touch ID / security key)
// for one exact action + target and returns a single-use, 5-minute grant id.
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { stepUpOptions, stepUpVerify } from "./passkey.functions";

export function useStepUp() {
  const opts = useServerFn(stepUpOptions), verify = useServerFn(stepUpVerify);
  return useCallback(async (action: string, target: string) => {
    if (!browserSupportsWebAuthn()) throw new Error("This browser doesn't support passkeys, so this action is blocked here.");
    const o = await opts({ data: { action, target } });
    const response = await startAuthentication({ optionsJSON: o.options });
    const g = await verify({ data: { challengeId: o.challengeId, response } });
    return g.grantId;
  }, [opts, verify]);
}

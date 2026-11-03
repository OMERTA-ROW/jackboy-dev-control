// Browser side of passkey step-up: asks the device for a passkey (Face ID / Touch ID / security key)
// for one exact action + target and returns a single-use, 5-minute grant id.
import { useServerFn } from "@tanstack/react-start";
import { useCallback } from "react";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { stepUpOptions, stepUpRecent, stepUpVerify } from "./passkey.functions";
import { passkeyErrorText } from "./passkey-origin";

export function useStepUp() {
  const opts = useServerFn(stepUpOptions), verify = useServerFn(stepUpVerify), recent = useServerFn(stepUpRecent);
  return useCallback(async (action: string, target: string) => {
    // Routine connection reviews skip the prompt if you confirmed with a passkey in the last 10 minutes.
    const reused = await recent({ data: { action, target } }).catch(() => null);
    if (reused) return reused.grantId;
    if (!browserSupportsWebAuthn()) throw new Error("This browser doesn't support passkeys, so this action is blocked here.");
    const o = await opts({ data: { action, target } });
    let response;
    try { response = await startAuthentication({ optionsJSON: o.options }); }
    catch (e) { throw new Error(passkeyErrorText(e, window.self !== window.top)); }
    const g = await verify({ data: { challengeId: o.challengeId, response } });
    return g.grantId;
  }, [opts, verify, recent]);
}

import { useEffect, useRef, useState } from "react";
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Fingerprint, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { subscribePasskeyJob, PASSKEY_CANCELLED, type ActiveJob, type Prepared } from "@/lib/passkey-prompt";
import { passkeyErrorText } from "@/lib/passkey-origin";

type Phase = "preparing" | "ready" | "device" | "checking" | "success" | "error" | "blocked";

/** The single passkey window. Mounted once in the root layout. */
export function PasskeyPromptHost() {
  const [job, setJob] = useState<ActiveJob | null>(null);
  const [phase, setPhase] = useState<Phase>("preparing");
  const [message, setMessage] = useState("");
  const [inFrame, setInFrame] = useState(false);
  const prepared = useRef<Prepared | null>(null);
  const settled = useRef(false);

  useEffect(() => subscribePasskeyJob(setJob), []);

  const prepare = async (j: ActiveJob) => {
    prepared.current = null;
    setPhase("preparing"); setMessage("");
    const frame = window.self !== window.top;
    setInFrame(frame);
    if (frame) { setPhase("blocked"); setMessage("Browsers block passkeys inside the editor frame. Open this page in its own tab and try again."); return; }
    if (!window.isSecureContext || !browserSupportsWebAuthn()) { setPhase("blocked"); setMessage("This browser doesn't support passkeys, so this action is blocked here. Try Safari, Chrome or Edge."); return; }
    try { prepared.current = await j.prepare(); setPhase("ready"); }
    catch (e) { setPhase("error"); setMessage((e as Error).message || "Couldn't start the passkey check."); }
  };

  useEffect(() => { settled.current = false; if (job) void prepare(job); }, [job]); // eslint-disable-line react-hooks/exhaustive-deps

  // Must run straight from the tap: the browser call is the first thing that happens.
  const confirmWithDevice = async () => {
    const j = job, p = prepared.current;
    if (!j || !p) return;
    setPhase("device"); setMessage("");
    let response: unknown;
    try {
      response = p.kind === "register"
        ? await startRegistration({ optionsJSON: p.options as never })
        : await startAuthentication({ optionsJSON: p.options as never });
    } catch (e) {
      prepared.current = null; // the browser may have used the challenge; get a new one on retry
      setPhase("error"); setMessage(passkeyErrorText(e, inFrame)); return;
    }
    setPhase("checking");
    try {
      const result = await j.finish(p.challengeId, response);
      setPhase("success"); setMessage(j.successText?.(result) ?? "Passkey confirmed.");
      settled.current = true;
      window.setTimeout(() => j.resolve(result), 900);
    } catch (e) {
      prepared.current = null;
      setPhase("error"); setMessage((e as Error).message || "Passkey check failed.");
    }
  };

  const cancel = () => { if (job && !settled.current) { settled.current = true; job.reject(new Error(message && phase !== "ready" ? message : PASSKEY_CANCELLED)); } };

  const open = !!job;
  const busy = phase === "preparing" || phase === "device" || phase === "checking";
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) cancel(); }}>
      <DialogContent aria-live="polite" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Fingerprint aria-hidden className="text-primary" />{job?.title ?? "Passkey"}</DialogTitle>
          {job?.description && <DialogDescription>{job.description}</DialogDescription>}
        </DialogHeader>
        <div className="min-h-12 text-sm" role="status">
          {phase === "preparing" && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="animate-spin" aria-hidden />Getting a one-time check ready…</p>}
          {phase === "ready" && <p className="text-muted-foreground">Tap the button, then confirm with Face ID, Touch ID, Windows Hello or your security key.</p>}
          {phase === "device" && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="animate-spin" aria-hidden />Waiting for your device…</p>}
          {phase === "checking" && <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="animate-spin" aria-hidden />Checking your passkey…</p>}
          {phase === "success" && <p className="flex items-center gap-2 text-success"><CheckCircle2 aria-hidden />{message}</p>}
          {(phase === "error" || phase === "blocked") && <p role="alert" className="flex items-start gap-2 text-destructive"><XCircle aria-hidden className="mt-0.5 shrink-0" />{message}</p>}
          {phase === "blocked" && inFrame && <a className="mt-2 inline-block underline" href={typeof window !== "undefined" ? window.location.href : "#"} target="_blank" rel="noopener noreferrer">Open this page in its own tab</a>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" disabled={busy || phase === "success"} onClick={cancel}>Cancel</Button>
          {phase === "ready" && <Button autoFocus onClick={() => void confirmWithDevice()}><Fingerprint aria-hidden />Use passkey</Button>}
          {phase === "error" && job && <Button onClick={() => void prepare(job)}>Try again</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

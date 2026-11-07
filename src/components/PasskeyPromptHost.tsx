import { useEffect, useRef, useState } from "react";
import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnAbortService } from "@simplewebauthn/browser";
import { Fingerprint, CheckCircle2, XCircle, Loader2, ScanFace, KeyRound, Smartphone, Lock } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { subscribePasskeyJob, PASSKEY_CANCELLED, PASSKEY_LIMITS, type ActiveJob, type Prepared } from "@/lib/passkey-prompt";
import { passkeyErrorText } from "@/lib/passkey-origin";
import { detectPasskeyMethod, readDeviceSignals, rememberAttachment, withTimeout, type PasskeyMethod } from "@/lib/passkey-method";

type Phase = "preparing" | "ready" | "device" | "checking" | "applying" | "success" | "error" | "blocked";
const BUSY: Phase[] = ["preparing", "device", "checking", "applying"];

function MethodIcon({ m }: { m: PasskeyMethod | null }) {
  const cls = "text-primary";
  if (!m) return <Fingerprint aria-hidden className={cls} />;
  if (m.id === "face_id" || m.id === "ipad_unlock") return <ScanFace aria-hidden className={cls} />;
  if (m.id === "password_manager") return <Lock aria-hidden className={cls} />;
  if (m.id === "phone") return <Smartphone aria-hidden className={cls} />;
  if (m.id === "security_key") return <KeyRound aria-hidden className={cls} />;
  return <Fingerprint aria-hidden className={cls} />;
}

/** The single passkey window. Mounted once in the root layout. Every step ends in success or a clear failure. */
export function PasskeyPromptHost() {
  const [job, setJob] = useState<ActiveJob | null>(null);
  const [phase, setPhase] = useState<Phase>("preparing");
  const [message, setMessage] = useState("");
  const [method, setMethod] = useState<PasskeyMethod | null>(null);
  const [inFrame, setInFrame] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [since, setSince] = useState(0);
  const [, tick] = useState(0);
  const prepared = useRef<Prepared | null>(null);
  const settled = useRef(false);
  const run = useRef(0); // bumps on every new attempt or cancel; late answers from older attempts are ignored
  const hiddenRef = useRef(false);
  hiddenRef.current = hidden;

  useEffect(() => subscribePasskeyJob(setJob), []);
  const busy = BUSY.includes(phase);
  useEffect(() => { if (!busy) return; const t = window.setInterval(() => tick((n) => n + 1), 1000); return () => window.clearInterval(t); }, [busy]);
  const enter = (p: Phase, msg = "") => { setPhase(p); setMessage(msg); setSince(Date.now()); };

  const fail = (j: ActiveJob, msg: string) => {
    enter("error", msg);
    if (hiddenRef.current && !settled.current) { settled.current = true; toast.error(msg); j.reject(new Error(msg)); }
  };

  const prepare = async (j: ActiveJob) => {
    const my = ++run.current;
    prepared.current = null;
    enter("preparing");
    const frame = window.self !== window.top;
    setInFrame(frame);
    if (frame) { enter("blocked", "Browsers block passkeys inside the editor frame. Open this page in its own tab and try again."); return; }
    if (!window.isSecureContext || !browserSupportsWebAuthn()) { enter("blocked", "This browser doesn't support passkeys, so this action is blocked here. Try Safari, Chrome or Edge."); return; }
    try {
      const p = await withTimeout(j.prepare(), PASSKEY_LIMITS.prepare, "Couldn't reach the server to start the passkey check. Nothing was changed. Try again.");
      if (my !== run.current) return;
      const m = detectPasskeyMethod(await readDeviceSignals(p.keys ?? []));
      if (my !== run.current) return;
      prepared.current = p; setMethod(m); enter("ready");
      // If the tap that opened this window still counts as a fresh tap, go straight to the device sheet.
      const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
      if (activation?.isActive) void confirmWithDevice(true, m, j);
    } catch (e) {
      if (my !== run.current) return;
      fail(j, (e as Error).message || "Couldn't start the passkey check.");
    }
  };

  useEffect(() => { settled.current = false; setHidden(false); if (job) void prepare(job); }, [job]); // eslint-disable-line react-hooks/exhaustive-deps

  // Must run straight from the tap: the browser call is the first thing that happens.
  const confirmWithDevice = async (auto = false, m: PasskeyMethod | null = method, current: ActiveJob | null = job) => {
    const p = prepared.current;
    if (!current || !p) return;
    const my = ++run.current;
    enter("device");
    const started = Date.now();
    const optionsJSON = { ...(p.options as Record<string, unknown>), ...(m?.hints.length ? { hints: m.hints } : {}) } as never;
    let response: { authenticatorAttachment?: string | null };
    try {
      response = await withTimeout(
        (p.kind === "register" ? startRegistration({ optionsJSON }) : startAuthentication({ optionsJSON })) as Promise<unknown>,
        PASSKEY_LIMITS.device,
        "Your device didn't answer in time. Nothing was changed. Try again.",
      ) as typeof response;
    } catch (e) {
      if (my !== run.current) return;
      WebAuthnAbortService.cancelCeremony();
      const name = (e as { name?: string })?.name;
      // Opened without a fresh tap and the browser refused at once: just wait for the button tap.
      if (auto && name === "NotAllowedError" && Date.now() - started < 2000) { enter("ready"); return; }
      prepared.current = null; // the browser may have used the challenge; get a new one on retry
      fail(current, passkeyErrorText(e, inFrame)); return;
    }
    rememberAttachment(response.authenticatorAttachment);
    enter("checking");
    let verified: unknown;
    try {
      verified = await withTimeout(current.finish(p.challengeId, response), PASSKEY_LIMITS.verify, "The server didn't confirm your passkey in time. Nothing was changed. Try again.");
    } catch (e) {
      if (my !== run.current) return;
      prepared.current = null;
      fail(current, (e as Error).message || "Passkey check failed. Nothing was changed."); return;
    }
    if (my !== run.current) return;
    let result = verified;
    if (current.apply) {
      enter("applying", current.applyingText ?? "Passkey confirmed. Making the change…");
      try { result = await current.apply(verified); }
      catch (e) {
        prepared.current = null;
        fail(current, `Passkey confirmed, but the change didn't go through: ${(e as Error).message || "unknown error"}`); return;
      }
    }
    const text = current.successText?.(result) ?? "Passkey confirmed.";
    enter("success", text);
    settled.current = true;
    if (hiddenRef.current) { toast.success(text); current.resolve(result); }
    else window.setTimeout(() => current.resolve(result), current.apply ? 1400 : 900);
  };

  const cancel = () => {
    if (!job || settled.current) return;
    if (phase === "applying") { setHidden(true); return; } // the change keeps running; its result arrives as a notice
    run.current++;
    if (phase === "device") WebAuthnAbortService.cancelCeremony();
    settled.current = true;
    job.reject(new Error(phase === "error" || phase === "blocked" ? message : PASSKEY_CANCELLED));
  };

  const open = !!job && !hidden;
  const secs = since ? Math.max(0, Math.floor((Date.now() - since) / 1000)) : 0;
  const wait = (text: string) => <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="animate-spin" aria-hidden />{text}{secs >= 2 ? ` (${secs}s)` : ""}</p>;
  const deviceText = method && method.id !== "device" ? `Waiting for ${method.label}…` : "Waiting for your device…";
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) cancel(); }}>
      <DialogContent aria-live="polite" onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><MethodIcon m={method} />{job?.title ?? "Passkey"}</DialogTitle>
          {job?.step && <p className="text-xs font-medium text-electric">{job.step}</p>}
          {job?.description && <DialogDescription>{job.description}</DialogDescription>}
        </DialogHeader>
        <div className="min-h-12 text-sm" role="status">
          {phase === "preparing" && wait("Getting a one-time check ready…")}
          {phase === "ready" && <p className="text-muted-foreground">{method?.instruction ?? "Confirm on your device when it asks."}</p>}
          {phase === "device" && <>{wait(deviceText)}{method && <p className="mt-1 text-xs text-muted-foreground">{method.instruction}</p>}</>}
          {phase === "checking" && wait("Checking your passkey…")}
          {phase === "applying" && <><p className="mb-1 flex items-center gap-2 text-success"><CheckCircle2 aria-hidden />Passkey confirmed.</p>{wait(message)}</>}
          {phase === "success" && <p className="flex items-center gap-2 text-success"><CheckCircle2 aria-hidden />{message}</p>}
          {(phase === "error" || phase === "blocked") && <p role="alert" className="flex items-start gap-2 text-destructive"><XCircle aria-hidden className="mt-0.5 shrink-0" />{message}</p>}
          {phase === "blocked" && inFrame && <a className="mt-2 inline-block underline" href={typeof window !== "undefined" ? window.location.href : "#"} target="_blank" rel="noopener noreferrer">Open this page in its own tab</a>}
        </div>
        <DialogFooter className="gap-2">
          {phase !== "success" && <Button variant="ghost" onClick={cancel}>{phase === "applying" ? "Close (keeps going)" : phase === "error" || phase === "blocked" ? "Close" : "Cancel"}</Button>}
          {phase === "ready" && <Button autoFocus onClick={() => void confirmWithDevice(false)}><MethodIcon m={method} />{method?.button ?? "Use passkey"}</Button>}
          {phase === "error" && job && <Button onClick={() => void prepare(job)}>Try again</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

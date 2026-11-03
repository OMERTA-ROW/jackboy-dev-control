import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { listPasskeys, removePasskey, passkeyRegisterOptions, passkeyRegisterVerify, passkeyTestOptions, passkeyTestVerify } from "@/lib/passkey.functions";
import { passkeyErrorText } from "@/lib/passkey-origin";
import { btn } from "@/components/ProjectBits";
import { Button } from "@/components/ui/button";
import { Trash2, Plus } from "lucide-react";
import { useStepUp } from "@/lib/step-up-client";

export function PasskeyPanel() {
  const list = useServerFn(listPasskeys), opts = useServerFn(passkeyRegisterOptions), verify = useServerFn(passkeyRegisterVerify);
  const tOpts = useServerFn(passkeyTestOptions), tVerify = useServerFn(passkeyTestVerify);
  const remove = useServerFn(removePasskey), stepUp = useStepUp();
  const [name, setName] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [d, setD] = useState<Awaited<ReturnType<typeof listPasskeys>> | null>(null);
  const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [inFrame, setInFrame] = useState(false);
  const load = useCallback(() => list().then(setD).catch((e) => setMsg((e as Error).message)), [list]);
  useEffect(() => {
    setSupported(browserSupportsWebAuthn() && window.isSecureContext);
    setInFrame(window.self !== window.top);
    void load();
  }, [load]);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true); setMsg("");
    try { setMsg(await fn()); await load(); }
    catch (e) { setMsg(passkeyErrorText(e, inFrame)); } finally { setBusy(false); }
  };
  const add = () => run(async () => {
    const o = await opts();
    const response = await startRegistration({ optionsJSON: o.options });
    await verify({ data: { challengeId: o.challengeId, response, label: name.trim() || (navigator.platform ? `Passkey (${navigator.platform})` : "Passkey") } });
    setName("");
    return "Passkey saved for this address. Use \"Test my passkey\" to confirm it works.";
  });
  const test = () => run(async () => {
    const o = await tOpts();
    const response = await startAuthentication({ optionsJSON: o.options });
    const r = await tVerify({ data: { challengeId: o.challengeId, response } });
    return `Passkey verified: ${r.label}.`;
  });
  const here = d?.host ?? null;
  const hereKeys = d?.passkeys.filter((k) => k.rp_id === here) ?? [];
  return (
    <section aria-labelledby="passkeys" className="panel mb-6 p-4">
      <h2 id="passkeys" className="font-semibold">Security: passkey confirmation</h2>
      <p className="mt-1 text-sm text-muted-foreground">Merging or reverting an update asks for your passkey (Face ID, Touch ID or a security key). Each confirmation works once, for that one item, for 5 minutes. Voice can never stand in for it.</p>
      <p className="mt-1 text-xs text-muted-foreground">A passkey only works on the address it was made on. The published site and the preview each need their own.</p>
      {supported === false && <p className="mt-2 text-sm text-destructive">This browser or device doesn't support passkeys, so protected actions are blocked here. Try Safari, Chrome or Edge on a device with Face ID, Touch ID, Windows Hello or a security key.</p>}
      {inFrame && <p className="mt-2 text-sm text-warning">You're viewing the app inside the editor frame, where browsers block passkeys. <a className="underline" href={typeof window !== "undefined" ? window.location.href : "#"} target="_blank" rel="noopener noreferrer">Open this page in its own tab</a> to add or use a passkey.</p>}
      {d?.hostError && <p className="mt-2 text-sm text-destructive">{d.hostError}</p>}
      <p className="mt-2 text-sm">{d ? (here ? `${hereKeys.length} passkey(s) for ${here}` : "Passkeys unavailable on this address") : "Loading…"}</p>
      <ul className="mt-1 divide-y divide-border text-xs text-muted-foreground">{d?.passkeys.map((k) => <li key={k.id} className="flex flex-wrap items-center gap-2 py-2"><span className="min-w-0 flex-1 break-words">{k.label} · {k.rp_id ?? "unknown address"} · added {new Date(k.created_at).toLocaleDateString()}{k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleString()}` : ""}</span><Button variant="ghost" size="icon-sm" aria-label={`Remove ${k.label}`} disabled={busy} onClick={() => setConfirmRemove(k.id)}><Trash2 /></Button>{confirmRemove === k.id && <div className="flex w-full flex-wrap items-center gap-2"><span>Remove this device from Jackboy?{hereKeys.length === 1 && k.rp_id === here ? " This is your last passkey for this address; protected actions will need a new registration." : ""}</span><Button variant="destructive" size="sm" disabled={busy} onClick={() => void run(async () => { const grantId = await stepUp("remove_passkey", `passkey:${k.id}`); await remove({ data: { id: k.id, grantId } }); setConfirmRemove(null); return "Passkey removed from Jackboy. Remove the stored copy in your device's password manager separately."; })}>Confirm removal</Button><Button variant="ghost" size="sm" onClick={() => setConfirmRemove(null)}>Cancel</Button></div>}</li>)}</ul>
      <label className="mt-3 block text-sm">Device name<input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. iPhone or security key" className="mt-1 block w-full rounded-md border border-input bg-background px-3 py-2" /></label>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || supported === false || !here} onClick={add}><Plus />{busy ? "Waiting for device…" : "Add a passkey"}</Button>
        <button className={btn} disabled={busy || supported === false || hereKeys.length === 0} onClick={test}>Test my passkey</button>
      </div>
      {msg && <p aria-live="polite" className="mt-2 text-sm">{msg}</p>}
      {d && <ul className="mt-3 text-xs">{d.actions.map((a) => <li key={a.id}>{a.label}: {a.unavailable ? <span className="text-warning">blocked ({a.unavailable})</span> : <span className="text-success">passkey required</span>}</li>)}</ul>}
    </section>
  );
}

import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { listPasskeys, passkeyRegisterOptions, passkeyRegisterVerify, passkeyTestOptions, passkeyTestVerify } from "@/lib/passkey.functions";
import { passkeyErrorText } from "@/lib/passkey-origin";
import { btn } from "@/components/ProjectBits";

export function PasskeyPanel() {
  const list = useServerFn(listPasskeys), opts = useServerFn(passkeyRegisterOptions), verify = useServerFn(passkeyRegisterVerify);
  const tOpts = useServerFn(passkeyTestOptions), tVerify = useServerFn(passkeyTestVerify);
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
    await verify({ data: { challengeId: o.challengeId, response, label: navigator.platform ? `Passkey (${navigator.platform})` : "Passkey" } });
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
      <ul className="mt-1 text-xs text-muted-foreground">{d?.passkeys.map((k) => <li key={k.id}>{k.label} · {k.rp_id ?? "unknown address"} · added {new Date(k.created_at).toLocaleDateString()}{k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleString()}` : ""}</li>)}</ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={btn} disabled={busy || supported === false || !here} onClick={add}>{busy ? "Waiting for device…" : "Add a passkey"}</button>
        <button className={btn} disabled={busy || supported === false || hereKeys.length === 0} onClick={test}>Test my passkey</button>
      </div>
      {msg && <p aria-live="polite" className="mt-2 text-sm">{msg}</p>}
      {d && <ul className="mt-3 text-xs">{d.actions.map((a) => <li key={a.id}>{a.label}: {a.unavailable ? <span className="text-warning">blocked ({a.unavailable})</span> : <span className="text-success">passkey required</span>}</li>)}</ul>}
    </section>
  );
}

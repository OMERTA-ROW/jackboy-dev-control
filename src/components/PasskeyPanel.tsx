import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { listPasskeys, passkeyRegisterOptions, passkeyRegisterVerify } from "@/lib/passkey.functions";
import { btn } from "@/components/ProjectBits";

export function PasskeyPanel() {
  const list = useServerFn(listPasskeys), opts = useServerFn(passkeyRegisterOptions), verify = useServerFn(passkeyRegisterVerify);
  const [d, setD] = useState<Awaited<ReturnType<typeof listPasskeys>> | null>(null);
  const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const load = useCallback(() => list().then(setD).catch((e) => setMsg((e as Error).message)), [list]);
  useEffect(() => { setSupported(browserSupportsWebAuthn()); void load(); }, [load]);
  const add = async () => {
    setBusy(true); setMsg("");
    try { const o = await opts(); const response = await startRegistration({ optionsJSON: o.options }); await verify({ data: { challengeId: o.challengeId, response, label: "Passkey" } }); setMsg("Passkey added."); await load(); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section aria-labelledby="passkeys" className="panel mb-6 p-4">
      <h2 id="passkeys" className="font-semibold">Security: passkey confirmation</h2>
      <p className="mt-1 text-sm text-muted-foreground">Merging or reverting an update asks for your passkey (Face ID, Touch ID or a security key). Each confirmation works once, for that one item, for 5 minutes. Voice can never stand in for it.</p>
      {supported === false && <p className="mt-2 text-sm text-warning">This browser doesn't support passkeys, so protected actions are blocked here.</p>}
      <p className="mt-2 text-sm">{d ? `${d.passkeys.length} passkey(s) registered` : "Loading…"}</p>
      <ul className="mt-1 text-xs text-muted-foreground">{d?.passkeys.map((k) => <li key={k.id}>{k.label} · added {new Date(k.created_at).toLocaleDateString()}{k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleString()}` : ""}</li>)}</ul>
      <button className={`${btn} mt-3`} disabled={busy || supported === false} onClick={add}>{busy ? "Waiting for device…" : "Add a passkey"}</button>
      {msg && <p aria-live="polite" className="mt-2 text-sm">{msg}</p>}
      {d && <ul className="mt-3 text-xs">{d.actions.map((a) => <li key={a.id}>{a.label}: {a.unavailable ? <span className="text-warning">blocked ({a.unavailable})</span> : <span className="text-success">passkey required</span>}</li>)}</ul>}
    </section>
  );
}

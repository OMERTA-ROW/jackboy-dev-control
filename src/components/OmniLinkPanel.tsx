import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, ShieldAlert } from "lucide-react";
import { getOmniLink, runOmniHandshake } from "@/lib/omni-link.functions";
import { OmniHandoffPanel } from "./OmniHandoffPanel";

type Link = Awaited<ReturnType<typeof getOmniLink>>;

/** Live OMNI connection state from the server handshake, plus the job delivery queue. */
export function OmniLinkPanel() {
  const load = useServerFn(getOmniLink), hs = useServerFn(runOmniHandshake);
  const [d, setD] = useState<Link | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => load().then(setD).catch((e: Error) => setMsg(e.message)), [load]);
  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(true); setMsg(null);
    try {
      const r = (await fn()) as { verified?: boolean; error?: string | null; omni_version?: string } | null;
      const when = new Date().toLocaleTimeString();
      setMsg(r?.verified ? `${label} at ${when}: OMNI worker answered${r.omni_version ? ` (${r.omni_version})` : ""}.` : `${label} at ${when}: no answer${r?.error ? ` — ${r.error}` : ""}.`);
    } catch (e) { setMsg(`${label} failed: ${(e as Error).message}`); }
    finally { setBusy(false); void refresh(); }
  };

  const verified = Boolean(d?.connection?.verified);
  return (
    <>
    <section className="panel mb-4 p-4 text-sm" aria-labelledby="omni-link">
      <div className="flex flex-wrap items-center gap-2">
        {verified ? <CheckCircle2 className="h-4 w-4 text-success" /> : <ShieldAlert className="h-4 w-4 text-warning" />}
        <h2 id="omni-link" className="font-semibold">{verified ? `OMNI worker answered (${d?.connection?.omni_version})` : "OMNI worker: not answered yet"}</h2>
        <span className="w-full text-xs text-muted-foreground">This is the older worker check. The secure link's state is in "OMNI link values for Railway" above and in the Site Log (omni.link.handshake / omni.link.refused).</span>
        <div className="ml-auto flex gap-2">
          <button className="rounded-md border border-border px-3 py-1.5 hover:bg-muted disabled:opacity-50" disabled={busy || !d?.config.configured} onClick={() => act(() => hs(), "Check")}>Check connection</button>
        </div>
      </div>
      {d && !d.config.configured && <p className="mt-2 text-muted-foreground">Waiting for these secrets: {d.config.missing.join(", ")}.</p>}
      {d && !d.config.keyConfigured && <p role="alert" className="mt-2 text-destructive">OMNI key not configured. Add OMNI_API_KEY in Project Settings → Secrets and the same value on the OMNI worker host; this is separate from GITHUB_TOKEN. Add OMNI_API_URL and matching OMNI_CALLBACK_SECRET, then check the connection.</p>}
      {d?.connection?.last_error && <p className="mt-2 text-destructive">Last check: {d.connection.last_error}</p>}
      {d && <p className="mt-1 text-xs text-muted-foreground">OMNI reports results to {d.config.callbackUrl}</p>}
      <p className="mt-1 text-xs text-muted-foreground">Queued jobs remain unsent: a connection check does not authorize dispatch.</p>
      {msg && <p className="mt-2 break-words text-xs text-muted-foreground" role="status">{msg}</p>}
      {d && d.jobs.length > 0 && (
        <ul className="mt-3 divide-y divide-border">
          {d.jobs.map((j) => (
            <li key={j.id} className="flex flex-wrap gap-2 py-2">
              <span className="font-mono text-xs">{j.id.slice(0, 8)}</span>
              <span className="rounded border border-border px-1.5 text-xs">{j.status}</span>
              <span className="min-w-0 flex-1 truncate">{j.instructions}</span>
              {j.pr_url && <a className="text-primary underline" href={j.pr_url} target="_blank" rel="noreferrer">Pull request</a>}
              {j.last_error && <span className="w-full text-xs text-destructive">Try {j.attempts}: {j.last_error}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
    <OmniHandoffPanel />
    </>
  );
}

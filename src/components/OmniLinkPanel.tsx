import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, ShieldAlert } from "lucide-react";
import { getOmniLink, runOmniHandshake } from "@/lib/omni-link.functions";
import { OMNI_VERIFICATION_MAX_AGE_MS } from "@/lib/omni-link";
import { OmniHandoffPanel } from "./OmniHandoffPanel";

type Link = Awaited<ReturnType<typeof getOmniLink>>;

/** Live OMNI connection state from the server handshake, plus the job delivery queue. */
export function OmniLinkPanel() {
  const load = useServerFn(getOmniLink), hs = useServerFn(runOmniHandshake);
  const [d, setD] = useState<Link | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => load().then(setD).catch((e: Error) => setMsg(e.message)), [load]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const act = async (fn: () => Promise<{ verified: boolean; error?: string }>) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fn();
      setMsg(r.verified
        ? "Handshake verified for 5 minutes. No queued task was sent."
        : `OMNI link not verified: ${r.error ?? "details withheld"}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Connection check failed; no queued task was sent.");
    }
    finally { setBusy(false); void refresh(); }
  };

  const verified = Boolean(d?.connection?.verified);
  const verifiedAt = d?.connection?.verified_at ? Date.parse(d.connection.verified_at) : NaN;
  const expiresAt = Number.isFinite(verifiedAt) ? new Date(verifiedAt + OMNI_VERIFICATION_MAX_AGE_MS).toLocaleString() : null;
  return (
    <>
    <section className="panel mb-4 p-4 text-sm" aria-labelledby="omni-link">
      <div className="flex flex-wrap items-center gap-2">
        {verified ? <CheckCircle2 className="h-4 w-4 text-success" /> : <ShieldAlert className="h-4 w-4 text-warning" />}
        <h2 id="omni-link" className="font-semibold">{verified ? "OMNI link verified" : "OMNI link not verified"}</h2>
        <div className="ml-auto flex gap-2">
          <button className="rounded-md border border-border px-3 py-1.5 hover:bg-muted disabled:opacity-50" disabled={busy || !d?.config.configured} onClick={() => void act(() => hs())}>Check connection</button>
        </div>
      </div>
      {d && !d.config.configured && <p className="mt-2 text-muted-foreground">Waiting for these secrets: {d.config.missing.join(", ")}.</p>}
      {d && !d.config.keyConfigured && <p role="alert" className="mt-2 text-destructive">OMNI key not configured. Add OMNI_API_KEY in Project Settings → Secrets and the same value on the OMNI worker host; this is separate from GITHUB_TOKEN. Add OMNI_API_URL and matching OMNI_CALLBACK_SECRET, then check the connection.</p>}
      {d?.connection?.last_error && <p className="mt-2 text-destructive">Last check: {d.connection.last_error}</p>}
      {verified && d?.connection?.verified_at && <p className="mt-2 text-xs text-muted-foreground">Last successful handshake: {new Date(d.connection.verified_at).toLocaleString()} · verification expires {expiresAt} (5-minute limit).</p>}
      {!verified && d?.connection?.last_checked_at && <p className="mt-2 text-xs text-muted-foreground">Last connection check: {new Date(d.connection.last_checked_at).toLocaleString()}.</p>}
      {d && <p className="mt-1 text-xs text-muted-foreground">
        {d.config.callbackUrl ? `OMNI reports results to ${d.config.callbackUrl}` : "Callback URL is withheld because it is not a valid HTTPS URL."}
      </p>}
      <p className="mt-1 text-xs text-muted-foreground">A connection check is a handshake only. It does not authorize or send queued jobs, run a self-test, or deploy anything.</p>
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

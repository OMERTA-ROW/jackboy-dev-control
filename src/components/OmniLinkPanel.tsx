import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, ShieldAlert } from "lucide-react";
import { getOmniLink, probeOmniConnection } from "@/lib/omni-link.functions";
import { OmniHandoffPanel } from "./OmniHandoffPanel";

type Link = Awaited<ReturnType<typeof getOmniLink>>;
type Readiness = Awaited<ReturnType<typeof probeOmniConnection>>;

/** Read-only OMNI-initiated link readiness, plus queued legacy job records. */
export function OmniLinkPanel() {
  const load = useServerFn(getOmniLink), probe = useServerFn(probeOmniConnection);
  const [d, setD] = useState<Link | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => Promise.all([load(), probe()])
    .then(([link, report]) => {
      setD(link);
      setReadiness(report);
    })
    .catch((e: Error) => setMsg(e.message)), [load, probe]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const verifyLatest = async () => {
    setBusy(true); setMsg(null);
    try {
      const report = await probe();
      setReadiness(report);
      setMsg(report.verified
        ? "Readiness checks pass; an unexpired session is recorded, but live OMNI reachability was not tested."
        : `OMNI link readiness is blocked: ${report.missing.join(" · ")}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Read-only OMNI diagnostics could not be loaded.");
    } finally {
      setBusy(false);
    }
  };

  const ready = Boolean(readiness?.verified);
  return (
    <>
    <section className="panel mb-4 p-4 text-sm" aria-labelledby="omni-link">
      <div className="flex flex-wrap items-center gap-2">
        {ready ? <CheckCircle2 className="h-4 w-4 text-success" /> : <ShieldAlert className="h-4 w-4 text-warning" />}
        <h2 id="omni-link" className="font-semibold">OMNI-initiated link readiness</h2>
        <span className={`rounded border px-1.5 text-xs ${ready ? "border-success/50 text-success" : "border-warning/50 text-warning"}`}>
          {readiness ? ready ? "Prerequisites pass · reachability untested" : "Blocked" : "Checking…"}
        </span>
        <div className="ml-auto flex gap-2">
          <button type="button" className="rounded-md border border-border px-3 py-1.5 hover:bg-muted disabled:opacity-50" disabled={busy} onClick={() => void verifyLatest()}>
            {busy ? "Checking…" : "Verify latest link (read-only)"}
          </button>
        </div>
      </div>
      <p className="mt-2 text-muted-foreground">
        This check reads Jackboy's configured link settings, storage, recorded OMNI session, and runner configuration. It never calls OMNI, runs a self-test, sends jobs, enables the link, or deploys. A recorded session is not proof of current bridge reachability.
      </p>
      {readiness && <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
        {readiness.steps.map((step) => <li key={step.name}>{step.ok ? "✓" : "✗"} {step.name}: {step.detail}</li>)}
      </ul>}
      {msg && <p className="mt-2 break-words text-xs text-muted-foreground" role="status">{msg}</p>}
      {d && d.jobs.length > 0 && (
        <>
        <h3 className="mt-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Legacy outbound job records (this link check never sends them)</h3>
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
        </>
      )}
    </section>
    <OmniHandoffPanel />
    </>
  );
}

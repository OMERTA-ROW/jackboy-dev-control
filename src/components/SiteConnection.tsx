import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { StatusPill, btn } from "@/components/ProjectBits";
import { checkSites } from "@/lib/site-monitor.functions";
import { SITE_LABEL, SITE_TONE, type SiteStatus } from "@/lib/site-monitor";
import type { HubRow } from "@/lib/project-hub.functions";

/** Real site reachability evidence for one project, plus Check now and next-step actions. */
export function SiteConnection({ p, onChanged, onEdit }: { p: HubRow; onChanged: () => void; onEdit: () => void }) {
  const check = useServerFn(checkSites);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const s = (p.site_url ? p.site_status : "needs_address") as SiteStatus;
  const ev = p.site_evidence ?? {};
  const http = ev.http;
  const run = async () => { setBusy(true); setErr(""); try { await check({ data: { ids: [p.id] } }); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  return (
    <section className="panel p-5" aria-labelledby="site-conn">
      <div className="flex items-center justify-between gap-2">
        <h2 id="site-conn" className="font-semibold">Site connection</h2>
        <StatusPill status={{ label: busy ? "Checking" : SITE_LABEL[s] ?? s, tone: busy ? "muted" : SITE_TONE[s] ?? "muted" }} />
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Address</dt><dd className="truncate">{p.site_url ?? "Not set"}</dd>
        <dt className="text-muted-foreground">Last checked</dt><dd>{p.site_checked_at ? new Date(p.site_checked_at).toLocaleString() : "Never"}</dd>
        {ev.dns && <><dt className="text-muted-foreground">DNS</dt><dd className="truncate">{ev.dns.ok ? ev.dns.addresses.join(", ") : ev.dns.error}</dd></>}
        {http && <><dt className="text-muted-foreground">HTTPS</dt><dd className="truncate">{http.error ?? `${http.status} in ${http.ms} ms${http.finalUrl && http.finalUrl !== ev.url ? ` → ${http.finalUrl}` : ""}`}</dd></>}
        {ev.reason && <><dt className="text-muted-foreground">Result</dt><dd>{ev.reason}</dd></>}
        <dt className="text-muted-foreground">Monitoring</dt><dd>{p.site_monitoring ? "Rechecked automatically (every 6 h when healthy, sooner with backoff on failure)" : "Off"}</dd>
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">A reachable site does not mean Jackboy can change its code. Code access is verified separately in AutoConnect.</p>
      {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={busy || !p.site_url} onClick={run}>{busy ? "Checking…" : "Check now"}</button>
        {(s === "needs_address" || s === "error" || s === "unreachable") && <button type="button" className={btn} onClick={onEdit}>{p.site_url ? "Fix address" : "Add site address"}</button>}
        {s === "auth_needed" && <Link to="/autoconnect" className={btn}>Review authorization</Link>}
        <Link to="/autoconnect" className={btn}>Reconnect code access</Link>
      </div>
    </section>
  );
}

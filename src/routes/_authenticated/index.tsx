import type React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { StatusPill, btn, primaryBtn } from "@/components/ProjectBits";
import { scanNow } from "@/lib/autopilot.functions";
import { getProjectHub } from "@/lib/project-hub.functions";
import { latestScans, projectStatus } from "@/lib/project-hub";
import { groupProposals, optimisticApprove } from "@/lib/approval-state";
import { setProposalStatus } from "@/lib/update-writer.functions";

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({
    meta: [
      { title: "Home — Jackboy" },
      { name: "description", content: "Connect a project, see its status and scan it." },
      { property: "og:title", content: "Home — Jackboy" },
      { property: "og:description", content: "Owner home: connect projects, check status, run scans." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Home,
});

type Hub = Awaited<ReturnType<typeof getProjectHub>>;

function Home() {
  const load = useServerFn(getProjectHub), scan = useServerFn(scanNow);
  const [hub, setHub] = useState<Hub | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const navigate = useNavigate();
  const refresh = useCallback(() => load().then(setHub).catch((e) => setErr((e as Error).message)), [load]);
  const approve = useServerFn(setProposalStatus);
  const [approving, setApproving] = useState<Set<string>>(new Set());
  useEffect(() => {
    void refresh();
    // Revalidate from the server: other tabs, tab focus, and a slow poll. No cached counts.
    const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("jackboy-approvals") : null;
    if (bc) bc.onmessage = () => void refresh();
    const onVis = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVis);
    const t = setInterval(() => void refresh(), 30_000);
    return () => { bc?.close(); document.removeEventListener("visibilitychange", onVis); clearInterval(t); };
  }, [refresh]);
  const groups = hub ? groupProposals(hub.waiting) : null;
  const doApprove = async (id: string, title: string) => {
    if (approving.has(id)) return; // duplicate click
    setApproving((s) => new Set(s).add(id)); setErr("");
    setHub((h) => (h ? { ...h, waiting: optimisticApprove(h.waiting, id) } : h));
    try {
      const r = await approve({ data: { id, status: "approved" } });
      setMsg(r.already ? `${title} was already approved.` : r.continued === "pr_open" ? `${title} approved; draft pull request opened.` : r.continued ? `${title} approved, but the next step ${r.continued}` : `${title} approved.`);
    } catch (e) { setErr((e as Error).message); }
    finally {
      setApproving((s) => { const n = new Set(s); n.delete(id); return n; });
      try { new BroadcastChannel("jackboy-approvals").postMessage("changed"); } catch { /* unsupported */ }
      await refresh();
    }
  };
  const last = hub ? latestScans(hub.scans) : new Map();

  const runScan = async (id: string, name: string) => {
    setBusy(id); setErr(""); setMsg("");
    try { const r = await scan({ data: { id } }); setMsg(`${name}: checked ${r.pages} page(s), ${r.findings} finding(s).`); navigate({ to: "/project/$id", params: { id } }); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <>
      <PageHeader title="Home" subtitle="Select project → Scan → Review demo items and errors → Repair → Verify." />
      <section className="panel mb-6 flex flex-col items-start gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-semibold">Add a project to Jackboy</h2>
          <p className="text-sm text-muted-foreground">Pick from your saved Lovable list or enter a site address.</p>
        </div>
        <Link to="/connect" className={primaryBtn}><Plus className="h-4 w-4" aria-hidden /> Connect Project</Link>
      </section>

      {err && <p role="alert" className="mb-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive">{err}</p>}
      {msg && <p aria-live="polite" className="mb-4 rounded-md border border-border p-3 text-sm">{msg}</p>}

      <section aria-labelledby="my-projects">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="my-projects" className="text-sm font-semibold uppercase tracking-wider text-silver">My Projects</h2>
          <Link to="/projects" className="text-xs text-electric">See all →</Link>
        </div>
        {!hub ? <p className="text-sm text-muted-foreground">Loading…</p> : hub.projects.length === 0 ? (
          <p className="panel p-5 text-sm text-muted-foreground">No projects connected yet. Use <strong>Connect Project</strong> to add your first one.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {hub.projects.slice(0, 9).map((p) => {
              const waiting = groups!.pending.filter((w) => w.project_id === p.id).length;
              return (
                <li key={p.id} className="panel flex flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <Link to="/project/$id" params={{ id: p.id }} className="font-semibold hover:text-electric">{p.name}</Link>
                    <StatusPill status={projectStatus(p, last.get(p.id))} />
                  </div>
                  <p className="truncate text-xs text-muted-foreground">{p.site_url ?? "No site address"}{waiting ? ` · ${waiting} waiting for approval` : ""}</p>
                  <div className="mt-auto flex gap-2">
                    <button className={btn} disabled={!p.site_url || busy !== null} onClick={() => runScan(p.id, p.name)}>{busy === p.id ? "Scanning…" : "Scan & Review"}</button>
                    <Link to="/project/$id" params={{ id: p.id }} className={btn}>Manage</Link>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {groups && (
        <section aria-label="Approvals and work" className="mt-6 grid gap-3 lg:grid-cols-3">
          <WorkList title={`Pending approval (${groups.pending.length})`} rows={groups.pending} empty="Nothing needs your approval."
            action={(w) => w.status === "draft" ? <button className={btn} disabled={approving.has(w.id)} onClick={() => doApprove(w.id, w.title)}>{approving.has(w.id) ? "Approving…" : "Approve"}</button> : <Link to="/updates" className={btn}>Review</Link>} />
          <WorkList title={`In progress (${groups.in_progress.length})`} rows={groups.in_progress} empty="Nothing running." />
          <WorkList title={`Action required (${groups.action_required.length})`} rows={groups.action_required} empty="No problems." />
        </section>
      )}
      {groups && <p className="mt-3 text-xs"><Link to="/updates" className="text-electric underline">Full update queue and history</Link></p>}
    </>
  );
}

function WorkList({ title, rows, empty, action }: { title: string; rows: { id: string; title: string; reason: string; pr_url: string | null }[]; empty: string; action?: (r: never) => React.ReactNode }) {
  return (
    <div className="panel p-4">
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {rows.length === 0 ? <p className="text-xs text-muted-foreground">{empty}</p> : (
        <ul className="space-y-2">{rows.map((r) => (
          <li key={r.id} className="flex items-start justify-between gap-2 text-sm">
            <div className="min-w-0"><p className="truncate">{r.title}</p><p className="text-xs text-muted-foreground">{r.reason}{r.pr_url && <> · <a href={r.pr_url} target="_blank" rel="noreferrer" className="text-electric">PR</a></>}</p></div>
            {action?.(r as never)}
          </li>))}</ul>
      )}
    </div>
  );
}

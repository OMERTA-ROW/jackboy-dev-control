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
  useEffect(() => { void refresh(); }, [refresh]);
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
              const waiting = hub.waiting.filter((w) => w.project_id === p.id).length;
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
      {hub && hub.waiting.length > 0 && (
        <p className="mt-6 text-sm"><Link to="/updates" className="text-electric underline">{hub.waiting.length} update(s) waiting for your approval</Link></p>
      )}
    </>
  );
}

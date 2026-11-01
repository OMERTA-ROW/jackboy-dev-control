import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { StatusPill, btn, field, primaryBtn } from "@/components/ProjectBits";
import { getProjectHub } from "@/lib/project-hub.functions";
import { latestScans, projectStatus, searchByName } from "@/lib/project-hub";

export const Route = createFileRoute("/_authenticated/projects")({
  head: () => ({
    meta: [
      { title: "Projects — Jackboy" },
      { name: "description", content: "Search and manage the projects connected to Jackboy." },
      { property: "og:title", content: "Projects — Jackboy" },
      { property: "og:description", content: "Searchable list of connected projects with status and actions." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Projects,
});

type Hub = Awaited<ReturnType<typeof getProjectHub>>;

function Projects() {
  const load = useServerFn(getProjectHub);
  const [hub, setHub] = useState<Hub | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { load().then(setHub).catch((e) => setErr((e as Error).message)); }, [load]);
  const last = hub ? latestScans(hub.scans) : new Map();
  const list = hub ? searchByName(hub.projects, q) : [];

  return (
    <>
      <PageHeader title="Projects" subtitle="Every project connected to Jackboy. Pick one to see its health, scans and repairs." />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative flex-1">
          <span className="sr-only">Search projects</span>
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects…" className={`${field} pl-9`} />
        </label>
        <Link to="/connect" className={primaryBtn}><Plus className="h-4 w-4" aria-hidden /> Connect Project</Link>
      </div>
      {err && <p role="alert" className="mb-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive">{err}</p>}
      {!hub ? <p className="text-sm text-muted-foreground">Loading…</p> : hub.projects.length === 0 ? (
        <p className="panel p-5 text-sm text-muted-foreground">
          No connected projects yet.{hub.inventory.length > 0 && ` ${hub.inventory.length} saved Lovable projects are ready to pick in Connect Project.`}
        </p>
      ) : list.length === 0 ? <p className="text-sm text-muted-foreground">No project matches “{q}”.</p> : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {list.map((p) => (
            <li key={p.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="font-medium">{p.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {p.site_url ?? "No site address"} · {p.github_repo ? `Repo ${p.github_repo}` : "No repo"} · Autopilot {p.autopilot ? "on" : "off"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusPill status={projectStatus(p, last.get(p.id))} />
                <Link to="/project/$id" params={{ id: p.id }} className={btn}>Manage</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

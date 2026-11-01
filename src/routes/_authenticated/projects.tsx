import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { StatusPill, btn, field, primaryBtn } from "@/components/ProjectBits";
import { getProjectHub } from "@/lib/project-hub.functions";
import { fixScan, scanNow } from "@/lib/autopilot.functions";
import { openPr } from "@/lib/update-writer.functions";
import { latestScans, projectStatus, searchByName } from "@/lib/project-hub";
import { MAX_CONCURRENCY, approvedUndelivered, eligible, runBounded, sanitizeSelection, type BatchAction } from "@/lib/batch";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/projects")({
  head: () => ({
    meta: [
      { title: "Projects — Jackboy" },
      { name: "description", content: "Select one or many projects to scan, repair, review and distribute updates." },
      { property: "og:title", content: "Projects — Jackboy" },
      { property: "og:description", content: "Multi-project scan, repair and approved update distribution." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Projects,
});

type Hub = Awaited<ReturnType<typeof getProjectHub>>;
type RowState = { state: "queued" | "running" | "done" | "skipped" | "error"; text: string };
const LABEL: Record<BatchAction, string> = { scan: "Scan", repair: "Prepare repair", distribute: "Distribute" };

function Projects() {
  const load = useServerFn(getProjectHub);
  const scan = useServerFn(scanNow);
  const repair = useServerFn(fixScan);
  const ship = useServerFn(openPr);
  const [hub, setHub] = useState<Hub | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string[]>([]);
  const [key, setKey] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => load().then(setHub).catch((e) => setErr((e as Error).message)), [load]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { supabase.auth.getUser().then(({ data }) => data.user && setKey(`jackboy.selection.${data.user.id}`)); }, []);
  useEffect(() => {
    if (!hub || !key) return;
    try { setSel(sanitizeSelection(JSON.parse(sessionStorage.getItem(key) ?? "[]"), hub.projects.map((p) => p.id))); } catch { setSel([]); }
  }, [hub, key]);
  const save = (next: string[]) => { setSel(next); if (key) sessionStorage.setItem(key, JSON.stringify(next)); };

  const last = useMemo(() => (hub ? latestScans(hub.scans) : new Map()), [hub]);
  const list = hub ? searchByName(hub.projects, q) : [];
  const selected = hub ? hub.projects.filter((p) => sel.includes(p.id)) : [];
  const toggle = (id: string) => save(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);

  async function run(action: BatchAction) {
    if (!hub) return;
    setBusy(true);
    const init: Record<string, RowState> = {};
    const todo = selected.filter((p) => {
      const e = eligible(action, p, last.get(p.id), hub.waiting);
      init[p.id] = e.ok ? { state: "queued", text: `${LABEL[action]} queued` } : { state: "skipped", text: `Skipped: ${e.reason}` };
      return e.ok;
    });
    setRows(init);
    await runBounded(todo, MAX_CONCURRENCY, async (p) => {
      setRows((r) => ({ ...r, [p.id]: { state: "running", text: `${LABEL[action]} running…` } }));
      if (action === "scan") { const r = await scan({ data: { id: p.id } }); return `Scanned ${r.pages} page${r.pages === 1 ? "" : "s"}, ${r.findings} finding${r.findings === 1 ? "" : "s"}`; }
      if (action === "repair") { await repair({ data: { id: last.get(p.id)!.id } }); return "Repair prepared — waiting in Approvals"; }
      const items = approvedUndelivered(p.id, hub.waiting);
      for (const u of items) await ship({ data: { id: u.id } });
      return `Opened ${items.length} pull request${items.length === 1 ? "" : "s"} for review`;
    }, (p, r) => setRows((s) => ({ ...s, [p.id]: r.ok ? { state: "done", text: r.value } : { state: "error", text: `Failed: ${r.error}` } })));
    setBusy(false);
    void refresh();
  }

  const waitingSel = hub ? hub.waiting.filter((w) => sel.includes(w.project_id)).length : 0;

  return (
    <>
      <PageHeader title="Projects" subtitle="Tick one or more projects, then scan, repair, review and distribute approved updates." />
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
          No projects connected.{hub.inventory.length > 0 && ` ${hub.inventory.length} saved Lovable projects are ready to pick in Connect Project.`}
        </p>
      ) : (
        <>
          <div className="panel mb-4 flex flex-col gap-3 p-4" aria-label="Selected projects actions">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium" aria-live="polite">{sel.length} of {hub.projects.length} selected</span>
              <button type="button" className={btn} onClick={() => save(Array.from(new Set([...sel, ...list.map((p) => p.id)])))}>Select All</button>
              <button type="button" className={btn} onClick={() => save([])}>Clear All</button>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btn} disabled={busy || !sel.length} onClick={() => run("scan")}>Scan Selected</button>
              <button type="button" className={btn} disabled={busy || !sel.length} onClick={() => run("repair")}>Prepare Repairs</button>
              <Link to="/updates" className={btn}>Review Approvals{sel.length ? ` (${waitingSel})` : ""}</Link>
              <button type="button" className={btn} disabled={busy || !sel.length} onClick={() => run("distribute")}>Distribute Approved Updates</button>
            </div>
            <p className="text-xs text-muted-foreground">Runs {MAX_CONCURRENCY} projects at a time. Distribute opens pull requests on private repos for review; nothing is merged or published automatically.</p>
          </div>
          {list.length === 0 ? <p className="text-sm text-muted-foreground">No project matches “{q}”.</p> : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {list.map((p) => {
                const r = rows[p.id];
                return (
                  <li key={p.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <label className="flex min-w-0 cursor-pointer items-start gap-3">
                      <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--color-electric)]" checked={sel.includes(p.id)} onChange={() => toggle(p.id)} aria-label={`Select ${p.name}`} />
                      <span className="min-w-0">
                        <span className="block font-medium">{p.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {p.site_url ?? "No site address"} · {p.github_repo ? `Repo ${p.github_repo}` : "No repo"} · Autopilot {p.autopilot ? "on" : "off"}
                        </span>
                        {r && <span role="status" className={`block text-xs ${r.state === "error" ? "text-destructive" : r.state === "done" ? "text-success" : "text-muted-foreground"}`}>{r.text}</span>}
                      </span>
                    </label>
                    <div className="flex items-center gap-2">
                      <StatusPill status={projectStatus(p, last.get(p.id))} />
                      <Link to="/project/$id" params={{ id: p.id }} className={btn}>Manage</Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </>
  );
}

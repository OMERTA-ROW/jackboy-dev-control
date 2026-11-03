import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { btn, field, primaryBtn } from "@/components/ProjectBits";
import { searchByName } from "@/lib/project-hub";
import { sanitizeSelection, runBounded, MAX_CONCURRENCY } from "@/lib/batch";
import { agentState, connectRows, devPriority, loopEligible, newProjectInput, selectAll, toggle, type ConnectRow } from "@/lib/connect-select";
import { saveProject } from "@/lib/update-writer.functions";
import { foundryInspect, getFoundry } from "@/lib/foundry.functions";
import { setDevEnabled, type getProjectHub } from "@/lib/project-hub.functions";
import { ConnectedProjectsResync } from "@/components/RepositorySync";
import { resyncProject } from "@/lib/project-resync.functions";

type Hub = Awaited<ReturnType<typeof getProjectHub>>;
type Task = { project_id: string | null; state: string; blocked_reason: string | null; paused: boolean };
const STATUS: Record<ConnectRow["status"], string> = { saved_only: "Not connected", connected_no_repo: "Connected · no repo", repo_linked: "Repo linked", repo_error: "Repo error" };
const TONE: Record<string, string> = { Online: "text-success", Working: "text-electric", Blocked: "text-destructive", Offline: "text-muted-foreground" };

export function MultiSelect({ hub, onPick, reload }: { hub: Hub | null; onPick: (name: string, ref: string | null) => void; reload: () => Promise<unknown> }) {
  const setDev = useServerFn(setDevEnabled);
  const resync = useServerFn(resyncProject);
  const save = useServerFn(saveProject), inspect = useServerFn(foundryInspect), foundry = useServerFn(getFoundry);
  const [uid, setUid] = useState<string | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, string>>({});
  const rows = useMemo(() => (hub ? connectRows(hub.projects, hub.inventory) : []), [hub]);
  const visible = searchByName(rows, q);
  const storeKey = uid ? `jackboy.connect.sel.${uid}` : null;

  const refreshTasks = () => foundry().then((f) => setTasks(f.tasks as Task[])).catch(() => {});
  useEffect(() => { supabase.auth.getUser().then(({ data }) => setUid(data.user?.id ?? null)); refreshTasks(); }, []);
  useEffect(() => { const refresh = () => void refreshTasks(); window.addEventListener("jackboy:permissions-checked", refresh); return () => window.removeEventListener("jackboy:permissions-checked", refresh); }, [foundry]);
  useEffect(() => {
    if (!storeKey || !rows.length) return;
    try { setSel(sanitizeSelection(JSON.parse(localStorage.getItem(storeKey) ?? "[]"), rows.map((r) => r.key))); } catch { setSel([]); }
  }, [storeKey, rows]);
  const update = (next: string[]) => { setSel(next); if (storeKey) localStorage.setItem(storeKey, JSON.stringify(next)); };

  const chosen = rows.filter((r) => sel.includes(r.key));
  const toConnect = chosen.filter((r) => r.status === "saved_only");
  const note = (k: string, m: string) => setResults((r) => ({ ...r, [k]: m }));

  const connectSelected = async () => {
    setBusy(true);
    const created: Record<string, string> = {};
    // New picks are saved; already-connected picks are re-identified (repo, name, site, credential).
    await runBounded(chosen, MAX_CONCURRENCY, async (r) => {
      if (r.status === "saved_only") { const x = await save({ data: newProjectInput(r) }); created[r.key] = `p:${x.id}`; return "Connected (add a repo to enable coding)"; }
      const x = await resync({ data: { id: r.projectId! } });
      return `Reconnected · ${x.repo ?? "no repo linked"} · credential: ${x.credential}${x.changes.length ? ` · ${x.changes.join("; ")}` : ""}${x.notes[0] ? ` · ${x.notes[0]}` : ""}`;
    }, (r, o) => note(r.key, o.ok ? String(o.value) : `Failed: ${o.error}`));
    await reload();
    update(sel.map((k) => created[k] ?? k));
    setBusy(false);
  };
  const activate = async (on: boolean) => {
    setBusy(true);
    const targets = chosen.filter((r) => { if (!r.projectId) note(r.key, "Skipped: connect it first"); return Boolean(r.projectId); });
    await runBounded(targets, MAX_CONCURRENCY, (r) => setDev({ data: { id: r.projectId!, enabled: on } }), (r, o) => note(r.key, o.ok ? (on ? "Background work activated" : "Background work off") : `Failed: ${o.error}`));
    await reload(); setBusy(false);
  };
  const runLoop = async () => {
    setBusy(true);
    const run = chosen.filter((r) => { const e = loopEligible(r); if (!e.ok) note(r.key, `Skipped: ${e.reason}`); return e.ok; });
    await runBounded(run, MAX_CONCURRENCY, (r) => inspect({ data: { projectId: r.projectId! } }), (r, o) => {
      if (!o.ok) return note(r.key, `Failed: ${o.error}`);
      const v = o.value as { created: number; blocked?: string; findings?: number; inspectedFiles?: number };
      note(r.key, v.blocked ? `Blocked: ${v.blocked}` : v.created ? `Inspected ${v.inspectedFiles} files; prepared ${v.created} change on a branch — review it in Code Foundry` : `Inspected ${v.inspectedFiles ?? 0} files; nothing new to fix`);
    });
    await refreshTasks();
    setBusy(false);
  };

  return (
    <section aria-labelledby="step1" className="panel mb-4 p-5">
      <h2 id="step1" className="font-semibold">1. Select projects</h2>
      <ConnectedProjectsResync />
      <p className="mt-1 text-xs text-muted-foreground">Connected projects plus your saved list (a one-time snapshot, not live). Each project keeps its own permissions; nothing is shared between them.</p>
      {!hub ? <p className="mt-3 text-sm text-muted-foreground">Loading…</p> : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="relative min-w-0 flex-1">
              <span className="sr-only">Search projects</span>
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects…" className={`${field} pl-9`} />
            </label>
            <button type="button" className={btn} onClick={() => update(selectAll(sel, visible.map((r) => r.key)))}>Select all</button>
            <button type="button" className={btn} onClick={() => update([])}>Clear all</button>
            <span className="text-xs text-muted-foreground" aria-live="polite">{sel.length} of {rows.length} selected</span>
          </div>
          <ul aria-label="Projects" className="mt-3 grid max-h-96 gap-2 overflow-y-auto sm:grid-cols-2">
            {visible.map((r) => {
              const st = r.projectId ? agentState(r.status === "repo_linked", tasks.filter((t) => t.project_id === r.projectId)) : null;
              return (
                <li key={r.key} className={`rounded-md border p-3 text-sm ${sel.includes(r.key) ? "border-electric bg-accent/40" : "border-border"}`}>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" className="mt-1" checked={sel.includes(r.key)} onChange={() => update(toggle(sel, r.key))} aria-label={`Select ${r.name}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{r.name}{devPriority(r.name) < 100 && <span className="ml-2 rounded border border-border px-1 text-[10px] text-muted-foreground">priority {devPriority(r.name)}</span>}</span>
                      {r.projectId && <span className={`block text-xs ${r.devEnabled ? "text-success" : "text-muted-foreground"}`}>Background work: {r.devEnabled ? "activated by you" : "off (not authorized)"}</span>}
                      <span className="block text-xs text-muted-foreground">{STATUS[r.status]} — {r.detail}</span>
                      {st && <span className={`block text-xs ${TONE[st.label]}`}>{st.label}: {st.reason}</span>}
                      {results[r.key] && <span className="block text-xs">{results[r.key]}</span>}
                    </span>
                  </label>
                  <div className="mt-1 flex gap-3 text-xs">
                    {r.projectId ? <Link to="/project/$id" params={{ id: r.projectId }} className="text-electric underline">Open / add repo</Link>
                      : <button type="button" className="text-electric underline" onClick={() => onPick(r.name, r.lovableRef)}>Fill details below</button>}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={btn} disabled={busy || !chosen.length} onClick={connectSelected}>{toConnect.length === chosen.length ? `Connect selected (${chosen.length})` : `Connect / reconnect selected (${chosen.length})`}</button>
            <button type="button" className={btn} disabled={busy || !chosen.length} onClick={() => activate(true)}>Activate background work</button>
            <button type="button" className={btn} disabled={busy || !chosen.length} onClick={() => activate(false)}>Turn off background work</button>
            <button type="button" className={primaryBtn} disabled={busy || !chosen.length} onClick={runLoop}>{busy ? "Working…" : `Run coding loop on selected (${chosen.length})`}</button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">The coding loop reads the repo, prepares one minimal change on a separate branch and reads available checks. It stops for your approval before opening a draft pull request; merging and deploying are never automatic. Background work (recurring scans and fixes) runs only on projects you activate, in order: OMNI, JAX, Nano, Jail Release, then the rest. Being in this list never means a project is authorized.</p>
        </>
      )}
    </section>
  );
}

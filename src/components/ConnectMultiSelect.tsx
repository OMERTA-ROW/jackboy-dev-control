import { useServerFn } from "@tanstack/react-start";
import { useStepUp } from "@/lib/step-up-client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { btn, field, primaryBtn } from "@/components/ProjectBits";
import { searchByName } from "@/lib/project-hub";
import { sanitizeSelection, runBounded, MAX_CONCURRENCY } from "@/lib/batch";
import { agentState, backgroundState, bulkPlan, connectRows, devPriority, loopEligible, newProjectInput, selectAll, toggle, type ConnectRow } from "@/lib/connect-select";
import { saveProject } from "@/lib/update-writer.functions";
import { getFoundry } from "@/lib/foundry.functions";
import { isActive } from "@/lib/activity-feed";
import { ActivityFeed, useInspectRuns } from "@/components/InspectActivity";
import { setDevEnabled, type getProjectHub } from "@/lib/project-hub.functions";
import { ConnectedProjectsResync } from "@/components/RepositorySync";
import { resyncProject } from "@/lib/project-resync.functions";

type Hub = Awaited<ReturnType<typeof getProjectHub>>;
type Task = { project_id: string | null; state: string; blocked_reason: string | null; paused: boolean; title?: string | null };
const STATUS: Record<ConnectRow["status"], string> = { saved_only: "Not connected", connected_no_repo: "Connected · no repo", repo_linked: "Repo linked", repo_error: "Repo error" };
const TONE: Record<string, string> = { Online: "text-success", Working: "text-electric", Blocked: "text-destructive", Offline: "text-muted-foreground" };

export function MultiSelect({ hub, onPick, reload }: { hub: Hub | null; onPick: (name: string, ref: string | null) => void; reload: () => Promise<unknown> }) {
  const stepUp = useStepUp();
  const setDev = useServerFn(setDevEnabled);
  const resync = useServerFn(resyncProject);
  const save = useServerFn(saveProject), foundry = useServerFn(getFoundry);
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
  const plan = bulkPlan(chosen);
  const note = (k: string, m: string) => setResults((r) => ({ ...r, [k]: m }));
  // Live inspection runs: real server events, timestamps, stall warnings, Stop and Retry (shared with Code Foundry).
  const { runs: loops, active: running, queue, start, stop, retry } = useInspectRuns(() => void refreshTasks());
  const loopsRef = useRef(loops);
  loopsRef.current = loops;

  const connectSelected = async () => {
    setBusy(true);
    const created: Record<string, string> = {};
    for (const r of plan.needsRepo) note(r.key, "Connected — open it and link a GitHub repo to enable coding");
    // Only rows that are new or actually disconnected are (re)connected; healthy connections are left alone.
    await runBounded(plan.connect, MAX_CONCURRENCY, async (r) => {
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
    const targets = on ? plan.activate : plan.deactivate;
    if (on) {
      // One passkey per project (each grant is scoped to that project). The passkey window shows "n of N" and the real result.
      for (const [i, r] of targets.entries()) {
        note(r.key, "Waiting for your passkey…");
        try {
          await stepUp("autonomy_toggle", `dev:${r.projectId}`, {
            step: targets.length > 1 ? `Passkey ${i + 1} of ${targets.length} · ${r.name}` : r.name,
            applyingText: `Activating background work for ${r.name}…`,
            apply: (grantId) => setDev({ data: { id: r.projectId!, enabled: true, grantId } }),
            doneText: () => `Background work is active for ${r.name}.`,
          });
          note(r.key, "Background work activated");
        } catch (e) { note(r.key, `Not activated: ${(e as Error).message}`); }
      }
    } else {
      await runBounded(targets, MAX_CONCURRENCY, (r) => setDev({ data: { id: r.projectId!, enabled: false } }), (r, o) => note(r.key, o.ok ? "Background work turned off" : `Failed: ${o.error}`));
    }
    await reload(); setBusy(false);
  };
  const runLoop = async () => {
    setBusy(true);
    const run = chosen.filter((r) => { const e = loopEligible(r); if (!e.ok) note(r.key, `Skipped: ${e.reason}`); return e.ok; });
    for (const r of run) queue(r.key, r.projectId!);
    // A run stopped while still queued is skipped when its slot comes up.
    await runBounded(run, MAX_CONCURRENCY, async (r) => { if (loopsRef.current[r.key]?.phase === "queued") await start(r.key, r.projectId!); }, () => {});
    await refreshTasks();
    setBusy(false);
  };
  const loopSummary = (() => {
    const all = Object.values(loops);
    if (!all.length) return null;
    const finished = all.filter((l) => !isActive(l.phase)).length;
    const nothing = all.filter((l) => l.phase === "nothing").length;
    return { finished, total: all.length, nothing };
  })();

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
                      <span className={`block text-xs ${r.status === "repo_linked" ? "text-success" : r.status === "repo_error" ? "text-destructive" : "text-muted-foreground"}`}>{STATUS[r.status]} — {r.detail}</span>
                      {r.projectId && <BackgroundLine r={r} />}
                      {st && !loops[r.key] && <span className={`block text-xs ${TONE[st.label]}`}>{st.label}: {st.reason}</span>}
                      {results[r.key] && <span className="block text-xs" role="status">{results[r.key]}</span>}
                    </span>
                  </label>
                  {loops[r.key] && <ActivityFeed run={loops[r.key]!} name={r.name} onStop={() => void stop(r.key)} onRetry={() => void retry(r.key)} />}
                  <div className="mt-1 flex gap-3 text-xs">
                    {r.projectId ? <Link to="/project/$id" params={{ id: r.projectId }} className="text-electric underline">Open / add repo</Link>
                      : <button type="button" className="text-electric underline" onClick={() => onPick(r.name, r.lovableRef)}>Fill details below</button>}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {plan.connect.length > 0 && <button type="button" className={btn} disabled={busy} onClick={connectSelected}>{plan.connect.every((r) => r.status === "saved_only") ? `Connect selected (${plan.connect.length})` : `Connect / reconnect (${plan.connect.length})`}</button>}
            {plan.activate.length > 0 && <button type="button" className={btn} disabled={busy} onClick={() => activate(true)}>Activate background work ({plan.activate.length})</button>}
            {plan.active.length > 0 && <span className="inline-flex items-center gap-1 rounded-md border border-success/40 px-3 py-1.5 text-xs text-success"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden />Background work active ({plan.active.length})</span>}
            {plan.deactivate.length > 0 && <button type="button" className={btn} disabled={busy} onClick={() => activate(false)}>Turn off background work ({plan.deactivate.length})</button>}
            {chosen.length > 0 && <button type="button" className={primaryBtn} disabled={busy || running || !plan.loop.length} onClick={runLoop}>{running ? "Coding loop running…" : `Run coding loop (${plan.loop.length})`}</button>}
            {!chosen.length && <span className="text-xs text-muted-foreground">Select projects to see what you can do next.</span>}
          </div>
          {loopSummary && (
            <div className="mt-3" aria-live="polite">
              <div className="flex justify-between text-xs text-muted-foreground"><span>{loopSummary.finished === loopSummary.total ? (loopSummary.nothing === loopSummary.total ? "Coding loop finished — nothing to do" : "Coding loop finished") : "Coding loop running"}</span><span>{loopSummary.finished} of {loopSummary.total} done</span></div>
              <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={loopSummary.total} aria-valuenow={loopSummary.finished}>
                <div className="h-full bg-electric transition-all" style={{ width: `${(loopSummary.finished / loopSummary.total) * 100}%` }} />
              </div>
            </div>
          )}
          <p className="mt-2 text-xs text-muted-foreground">The coding loop reads the repo, prepares one minimal change on a separate branch and reads available checks. It stops for your approval before opening a draft pull request; merging and deploying are never automatic. Background work (recurring scans and fixes) runs only on projects you activate, in order: OMNI, JAX, Nano, Jail Release, then the rest. Being in this list never means a project is authorized.</p>
        </>
      )}
    </section>
  );
}

function BackgroundLine({ r }: { r: ConnectRow }) {
  const b = backgroundState(r);
  if (b === "active") return <span className="flex items-center gap-1 text-xs text-success"><CheckCircle2 className="h-3 w-3" aria-hidden />Background work: active</span>;
  if (b === "ready") return <span className="block text-xs text-muted-foreground">Background work: off — ready to activate</span>;
  if (b === "needs_reconnect") return <span className="block text-xs text-warning">Background work: stopped — reconnect first{r.devEnabled ? " (still switched on; turn it off or reconnect)" : ""}</span>;
  return <span className="block text-xs text-muted-foreground">Background work: needs a linked repo first</span>;
}

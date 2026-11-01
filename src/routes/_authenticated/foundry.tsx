import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { QualityMetrics } from "@/components/QualityMetrics";
import { ApprovalCard } from "@/components/ApprovalCard";
import { foundryAct, foundryControl, foundryInspect, foundrySchedule, getFoundry } from "@/lib/foundry.functions";
import { ACTIVE_APPROVAL, pickNext, TERMINAL, type State } from "@/lib/foundry";

export const Route = createFileRoute("/_authenticated/foundry")({
  head: () => ({
    meta: [
      { title: "Code Foundry — Jackboy" },
      { name: "description", content: "Jackboy's persistent development engine: inspections, patches, tests, approvals and draft pull requests with immutable history." },
      { property: "og:title", content: "Code Foundry — Jackboy" },
      { property: "og:description", content: "Inspect, patch, test, approve and open draft PRs with full history." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Foundry,
});

type Data = Awaited<ReturnType<typeof getFoundry>>;
const tone = (s: string) => s === "completed" || s === "connected" || s === "passed" ? "text-success" : s === "failed" || s === "error" || s === "rolled_back" ? "text-destructive" : s === "blocked" || s === "setup_required" || s === "not_runnable" || s === "pending" ? "text-warning" : "text-primary";

function Foundry() {
  const get = useServerFn(getFoundry), inspect = useServerFn(foundryInspect), act = useServerFn(foundryAct), ctl = useServerFn(foundryControl), sched = useServerFn(foundrySchedule);
  const [d, setD] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const load = useCallback(() => get().then(setD).catch((e) => setMsg((e as Error).message)), [get]);
  useEffect(() => { void load(); }, [load]);
  const run = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key); setMsg(null);
    try { const r = await f(); if (r && typeof r === "object" && "blocked" in r && r.blocked) setMsg(String(r.blocked)); else if (r && typeof r === "object" && "created" in r) setMsg(`Inspection done: ${String(r.created)} new task(s).`); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(null); void load(); }
  };
  const names = useMemo(() => Object.fromEntries((d?.projects ?? []).map((p) => [p.id, p.name])), [d]);
  if (!d) return <><PageHeader title="Code Foundry" subtitle="Loading…" />{msg && <p className="text-destructive">{msg}</p>}</>;
  const pending = d.tasks.filter((t) => ACTIVE_APPROVAL.includes(t.state as State));
  const active = d.tasks.filter((t) => !ACTIVE_APPROVAL.includes(t.state as State) && !TERMINAL.includes(t.state as State));
  const history = d.tasks.filter((t) => TERMINAL.includes(t.state as State) && (!q || `${t.title} ${t.pr_url ?? ""} ${t.branch ?? ""}`.toLowerCase().includes(q.toLowerCase())));
  const repoProjects = d.projects.filter((p) => p.github_repo);
  const next = pickNext(pending) ?? pickNext(active);
  const sc = d.schedule;
  const tickAge = sc?.last_tick_at ? (Date.now() - new Date(sc.last_tick_at).getTime()) / 3600_000 : null;

  const Task = ({ t }: { t: Data["tasks"][number] }) => {
    const ev = t.test_evidence as { status?: string; reason?: string };
    const files = (t.files as { path: string; additions?: number; deletions?: number; patch?: string }[]) ?? [];
    return (
      <li className="panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><p className="font-medium">{t.title}</p><p className="text-xs text-muted-foreground">{names[t.project_id] ?? "project"} · {t.repo} · {t.branch ?? "no branch"} · risk {t.risk}</p></div>
          <span className={`text-xs font-semibold uppercase ${tone(t.state)}`}>{t.state.replace("_", " ")}{t.paused ? " · paused" : ""}</span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{t.summary}</p>
        <p className="mt-2 text-xs">Tests: <span className={tone(ev.status ?? "")}>{ev.status ?? "none"}</span>{ev.reason ? ` — ${ev.reason}` : ""}</p>
        {t.blocked_reason && <p className="mt-1 text-xs text-warning">Blocked: {t.blocked_reason}</p>}
        {t.pr_url && <a className="mt-1 block text-xs text-primary underline" href={t.pr_url} target="_blank" rel="noreferrer">Draft PR #{t.pr_number} (not merged)</a>}
        {(() => { const pk = d.packages.find((x) => x.task_id === t.id); if (!pk) return null; const m = pk.manifest as { tests?: { checks?: { name: string; passed: boolean; detail: string }[]; ci?: { status: string } }; rollback?: { note?: string }; files?: { path: string; before_sha256: string; after_sha256: string }[] };
          return <details className="mt-2"><summary className="cursor-pointer text-xs">Update package {pk.version} · sha256 {pk.package_sha256.slice(0, 12)}…</summary>
            <ul className="mt-1 text-xs">{m.tests?.checks?.map((c) => <li key={c.name} className={c.passed ? "text-success" : "text-destructive"}>{c.passed ? "✓" : "✗"} {c.name}: {c.detail}</li>)}<li>CI: {m.tests?.ci?.status}</li></ul>
            {m.files?.map((f) => <p key={f.path} className="text-xs break-all">{f.path}: {f.before_sha256.slice(0, 12)} → {f.after_sha256.slice(0, 12)}</p>)}
            <p className="text-xs text-muted-foreground">Rollback: {m.rollback?.note}</p>
            <a className="text-xs text-primary underline" download={`jackboy-package-${pk.version}.json`} href={`data:application/json,${encodeURIComponent(JSON.stringify(pk.manifest, null, 2))}`}>Download manifest</a></details>; })()}
        {files.length > 0 && <details className="mt-2"><summary className="cursor-pointer text-xs">Diff ({files.length} file)</summary>{files.map((f) => <pre key={f.path} className="mt-1 max-h-60 overflow-auto rounded bg-muted p-2 text-xs">{f.path} +{f.additions ?? 0} −{f.deletions ?? 0}{"\n"}{f.patch}</pre>)}</details>}
        <div className="mt-3 flex flex-wrap gap-2">
          {t.state === "awaiting_approval" && <>
            <ApprovalCard taskId={t.id} onDone={(m) => { setMsg(m); void load(); }} />
            <button className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50" disabled={!!busy} onClick={() => run(t.id, () => act({ data: { id: t.id, op: "reject" } }))}>Reject</button>
          </>}
          {t.state === "blocked" && <button className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50" disabled={!!busy} onClick={() => run(t.id, () => act({ data: { id: t.id, op: "reject" } }))}>Reject</button>}
          {t.state === "blocked" && t.approved_action && <button className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50" disabled={!!busy} onClick={() => run(t.id, () => act({ data: { id: t.id, op: "retry" } }))}>Retry</button>}
          {!TERMINAL.includes(t.state as State) && <button className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50" disabled={!!busy} onClick={() => run(t.id, () => act({ data: { id: t.id, op: t.paused ? "resume" : "pause" } }))}>{t.paused ? "Resume" : "Pause"}</button>}
        </div>
      </li>
    );
  };

  return (
    <>
      <PageHeader title="Code Foundry" subtitle="Inspect → patch on a jackboy/* branch → test → your approval → draft PR. Nothing merges or deploys on its own." />
      <QualityMetrics />
      {msg && <p role="status" className="mb-4 text-sm text-warning">{msg}</p>}
      <section className="panel mb-4 grid gap-3 p-4 md:grid-cols-3" aria-label="Live work status">
        <div><p className="text-xs uppercase text-muted-foreground">Pipeline</p><p className={`font-semibold ${sc?.paused ? "text-warning" : "text-success"}`}>{sc?.paused ? "Paused" : "Running when triggered"}</p>
          <button className="mt-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50" disabled={!!busy} onClick={() => run("ctl", () => ctl({ data: { op: sc?.paused ? "resume_all" : "pause_all" } }))}>{sc?.paused ? "Resume all" : "Stop all"}</button></div>
        <div><p className="text-xs uppercase text-muted-foreground">Scheduler</p><p className="text-sm">{tickAge === null ? "Has not run this code yet (hourly job runs on the published app)." : `Last ran ${tickAge < 1 ? "under an hour" : `${Math.round(tickAge)} h`} ago: ${JSON.stringify(sc?.last_tick_result).slice(0, 120)}`}</p>
          <p className="text-xs text-muted-foreground">Runs today {sc?.runs_day === new Date().toISOString().slice(0, 10) ? sc?.runs_today : 0}/{sc?.max_runs_per_day} · max {sc?.max_in_flight} in flight</p></div>
        <div><p className="text-xs uppercase text-muted-foreground">Next task</p><p className="text-sm">{next ? `${next.title} (${next.state.replace("_", " ")})` : "None queued"}</p>
          <button className="mt-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50" disabled={!!busy || !!sc?.paused} onClick={() => run("adv", () => ctl({ data: { op: "advance" } }))}>Find next task now</button></div>
      </section>
      <section className="panel mb-4 p-4" aria-label="Connections">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-silver">Connections (checked live)</h2>
        <ul className="mt-2 grid gap-2 md:grid-cols-2">{d.connectors.map((c) => <li key={c.id} className="text-sm"><span className="font-medium">{c.name}</span> <span className={`text-xs uppercase ${tone(c.state)}`}>{c.state.replace("_", " ")}</span><br /><span className="text-xs text-muted-foreground">{c.detail}</span></li>)}</ul>
      </section>
      <section className="panel mb-4 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-silver">Inspect a project</h2>
        {repoProjects.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No project has a private repo linked yet.</p> :
          <div className="mt-2 flex flex-wrap gap-2">{repoProjects.map((p) => <button key={p.id} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50" disabled={!!busy} onClick={() => run(p.id, () => inspect({ data: { projectId: p.id } }))}>{busy === p.id ? "Inspecting…" : `Inspect ${p.name}`}</button>)}</div>}
        {d.schedule && <Schedule s={d.schedule} onSave={(v) => run("sched", () => sched({ data: v }))} />}
      </section>
      <h2 className="mb-2 text-lg font-semibold">Awaiting your approval ({pending.length})</h2>
      <ul className="mb-6 space-y-3">{pending.map((t) => <Fragment key={t.id}>{Task({ t })}</Fragment>)}{!pending.length && <li className="text-sm text-muted-foreground">Nothing waiting.</li>}</ul>
      {active.length > 0 && <><h2 className="mb-2 text-lg font-semibold">In progress / blocked</h2><ul className="mb-6 space-y-3">{active.map((t) => <Fragment key={t.id}>{Task({ t })}</Fragment>)}</ul></>}
      <h2 className="mb-2 text-lg font-semibold">History</h2>
      <input aria-label="Search history" className="mb-3 w-full rounded-md border border-border bg-background p-2 text-sm" placeholder="Search by title, branch or PR" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul className="mb-6 space-y-3">{history.map((t) => <Fragment key={t.id}>{Task({ t })}</Fragment>)}{!history.length && <li className="text-sm text-muted-foreground">No finished tasks.</li>}</ul>
      <details className="panel p-4"><summary className="cursor-pointer text-sm font-semibold">Audit trail ({d.events.length}, permanent)</summary>
        <ul className="mt-2 space-y-1 text-xs">{d.events.map((e) => <li key={e.id}><span className="text-muted-foreground">{new Date(e.created_at).toLocaleString()}</span> · {e.actor.split(":")[0]} · {e.action}{e.to_state ? ` → ${e.to_state}` : ""} {e.note && `— ${e.note}`}</li>)}</ul>
      </details>
    </>
  );
}

function Schedule({ s, onSave }: { s: NonNullable<Data["schedule"]>; onSave: (v: { enabled: boolean; interval_hours: number; daily_task_quota: number; max_in_flight: number; max_runs_per_day: number }) => void }) {
  const [v, setV] = useState({ enabled: s.enabled, interval_hours: s.interval_hours, daily_task_quota: s.daily_task_quota, max_in_flight: s.max_in_flight, max_runs_per_day: s.max_runs_per_day });
  return (
    <div className="mt-4 flex flex-wrap items-end gap-3 text-sm">
      <label className="flex items-center gap-2"><input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} />Recurring inspections</label>
      <label>Every (hours) <input type="number" min={1} max={720} className="w-20 rounded border border-border bg-background p-1" value={v.interval_hours} onChange={(e) => setV({ ...v, interval_hours: Number(e.target.value) })} /></label>
      <label>Max new tasks/day <input type="number" min={0} max={20} className="w-16 rounded border border-border bg-background p-1" value={v.daily_task_quota} onChange={(e) => setV({ ...v, daily_task_quota: Number(e.target.value) })} /></label>
      <label>Max runs/day <input type="number" min={1} max={200} className="w-16 rounded border border-border bg-background p-1" value={v.max_runs_per_day} onChange={(e) => setV({ ...v, max_runs_per_day: Number(e.target.value) })} /></label>
      <label>Max in flight <input type="number" min={1} max={10} className="w-14 rounded border border-border bg-background p-1" value={v.max_in_flight} onChange={(e) => setV({ ...v, max_in_flight: Number(e.target.value) })} /></label>
      <button className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50" onClick={() => onSave(v)}>Save schedule</button>
      <span className="text-xs text-muted-foreground">One project per run, rotating. Scheduled tasks always wait for approval.</span>
    </div>
  );
}

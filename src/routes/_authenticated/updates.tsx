import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { canTransition, STATUS_LABEL, STATUSES, type ProposalStatus } from "@/lib/update-writer";
import { editProposal, getQueue, markNotificationsRead, mergeUpdate, openPr, refreshPrChecks, revertUpdate, runNow, setCaps, setProposalStatus } from "@/lib/update-writer.functions";

export const Route = createFileRoute("/_authenticated/updates")({
  head: () => ({
    meta: [
      { title: "Update Queue — Jackboy" },
      { name: "description", content: "Review AI-written code updates, check builds, merge or revert pull requests." },
      { property: "og:title", content: "Update Queue — Jackboy" },
      { property: "og:description", content: "Owner review queue for Jackboy code updates and OMNI build prompts." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Updates,
});

type Q = Awaited<ReturnType<typeof getQueue>>;
type Prop = Q["proposals"][number];
const btn = "rounded-md border border-border px-3 py-1.5 text-xs hover:border-electric disabled:opacity-40";
const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm";
const COLOR: Record<ProposalStatus, string> = { draft: "text-silver", pr_open: "text-electric", approved: "text-success", merged: "text-success", rejected: "text-destructive", reverted: "text-muted-foreground", sent_to_omni: "text-electric" };
const CHECKS: Record<string, [string, string]> = { success: ["Build passed", "text-success"], failure: ["Build failed", "text-destructive"], pending: ["Build running", "text-electric"], none: ["No build checks in repo", "text-muted-foreground"] };

function Updates() {
  const f = { load: useServerFn(getQueue), run: useServerFn(runNow), caps: useServerFn(setCaps), read: useServerFn(markNotificationsRead) };
  const [q, setQ] = useState<Q | null>(null);
  const [filter, setFilter] = useState<ProposalStatus | "all">("all");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [caps, setCapsForm] = useState({ ai: 100, runs: 60 });
  const refresh = useCallback(() => f.load().then((r) => { setQ(r); if (r.settings) setCapsForm({ ai: r.settings.monthly_ai_cap, runs: r.settings.monthly_run_cap }); }).catch((e) => setErr((e as Error).message)), [f.load]);
  useEffect(() => { refresh(); }, [refresh]);
  const act = async (p: Promise<unknown>) => { setErr(null); try { await p; await refresh(); } catch (e) { setErr((e as Error).message); } };

  const runAll = async () => {
    setRunning(true); setErr(null); setMsg(null);
    try { const r = await f.run({ data: {} }); setMsg(r.skipped ? `Skipped: ${r.skipped}` : `${r.created} update(s) written.${r.errors.length ? ` Problems: ${r.errors.join("; ")}` : ""}`); await refresh(); }
    catch (e) { setErr((e as Error).message); } finally { setRunning(false); }
  };

  if (!q) return <><PageHeader title="Update Queue" subtitle="Loading…" />{err && <p className="text-sm text-destructive">{err}</p>}</>;
  const s = q.settings;
  const shown = q.proposals.filter((p) => filter === "all" || p.status === filter);
  const unread = q.notifications.filter((n) => !n.read);

  return (
    <>
      <PageHeader title="Update Queue" subtitle="Jackboy writes code changes as pull requests on your private repos. Nothing reaches your main branch until you merge here." />
      {err && <p role="alert" className="mb-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive">{err}</p>}
      {msg && <p aria-live="polite" className="mb-4 rounded-md border border-border p-3 text-sm">{msg}</p>}

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <section className="panel p-4 text-sm lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-semibold">Last run: {s?.last_run_at ? new Date(s.last_run_at).toLocaleString() : "never"}</div>
              <div className="text-xs text-muted-foreground">Checks hourly; each project runs on its own schedule (set on <Link to="/projects" className="underline">Projects</Link>). GitHub: {q.githubConfigured ? <span className="text-success">token set</span> : <span className="text-destructive">not connected</span>}</div>
              {s?.paused_reason && <div className="mt-1 text-xs text-destructive">Scheduled runs paused: {s.paused_reason}</div>}
            </div>
            <button className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50" disabled={running} onClick={runAll}>{running ? "Writing updates…" : "Run now"}</button>
          </div>
          <form className="mt-3 flex flex-wrap items-end gap-3 text-xs" onSubmit={(e) => { e.preventDefault(); act(f.caps({ data: { aiCap: caps.ai, runCap: caps.runs, clearPause: false } })); }}>
            <label>AI calls this month: <b>{q.usage.ai}</b> / <input type="number" min={0} max={10000} value={caps.ai} onChange={(e) => setCapsForm({ ...caps, ai: Number(e.target.value) })} className="w-20 rounded-md border border-input bg-background px-2 py-1" /></label>
            <label>Job runs this month: <b>{q.usage.runs}</b> / <input type="number" min={0} max={10000} value={caps.runs} onChange={(e) => setCapsForm({ ...caps, runs: Number(e.target.value) })} className="w-20 rounded-md border border-input bg-background px-2 py-1" /></label>
            <button className={btn}>Save caps</button>
            {s?.paused_reason && <button type="button" className={btn} onClick={() => act(f.caps({ data: { aiCap: caps.ai, runCap: caps.runs, clearPause: true } }))}>Resume schedule</button>}
          </form>
        </section>
        <section className="panel p-4 text-xs">
          <div className="mb-2 flex justify-between"><span className="font-semibold text-sm">Notifications {unread.length > 0 && <span className="text-electric">({unread.length})</span>}</span>{unread.length > 0 && <button className="underline" onClick={() => act(f.read())}>Mark read</button>}</div>
          <p className="mb-2 text-muted-foreground">Email alerts are not set up yet (needs an email domain). Alerts show here.</p>
          <ul className="max-h-40 space-y-1 overflow-auto">{q.notifications.length === 0 && <li className="text-muted-foreground">None.</li>}{q.notifications.map((n) => <li key={n.id} className={n.read ? "text-muted-foreground" : n.kind === "build_failed" || n.kind === "paused" || n.kind === "cap" ? "text-destructive" : ""}>{new Date(n.created_at).toLocaleString()} · {n.message}</li>)}</ul>
        </section>
      </div>

      <div className="mb-4 flex flex-wrap gap-2" role="tablist">
        {(["all", ...STATUSES] as const).map((k) => (
          <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)} className={`${btn} ${filter === k ? "border-electric text-electric" : ""}`}>
            {k === "all" ? "All" : STATUS_LABEL[k]} ({k === "all" ? q.proposals.length : q.proposals.filter((p) => p.status === k).length})
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="panel p-4 text-sm text-muted-foreground">No updates here. {q.proposals.length === 0 && <>Add projects on the <Link to="/projects" className="text-electric underline">Projects</Link> page, then press Run now.</>}</p>
      ) : (
        <ul className="space-y-4">{shown.map((p) => <ProposalCard key={p.id} p={p} act={act} />)}</ul>
      )}

      <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wider text-silver">Audit log</h2>
      <ul className="panel space-y-1 p-4 font-mono text-xs">
        {q.log.length === 0 && <li className="text-muted-foreground">Nothing yet.</li>}
        {q.log.map((l) => <li key={l.id}>{new Date(l.at).toLocaleString()} · {l.action} · <span className={l.outcome === "ok" ? "" : "text-destructive"}>{l.outcome}</span>{l.detail?.title ? ` · ${l.detail.title}` : l.detail?.name ? ` · ${l.detail.name}` : ""}{l.detail?.error ? ` · ${l.detail.error}` : ""}</li>)}
      </ul>
    </>
  );
}

function ProposalCard({ p, act }: { p: Prop; act: (x: Promise<unknown>) => Promise<void> }) {
  const f = { status: useServerFn(setProposalStatus), edit: useServerFn(editProposal), open: useServerFn(openPr), checks: useServerFn(refreshPrChecks), merge: useServerFn(mergeUpdate), revert: useServerFn(revertUpdate) };
  const [editing, setEditing] = useState(false);
  const [d, setD] = useState({ title: p.title, what_to_change: p.what_to_change, why: p.why, build_prompt: p.build_prompt });
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(p.build_prompt); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const can = (t: ProposalStatus) => canTransition(p.status, t);
  const run = async (x: Promise<unknown>) => { setBusy(true); await act(x); setBusy(false); };
  const chk = p.checks_state ? CHECKS[p.checks_state] : null;
  const merge = () => {
    const none = p.checks_state === "none";
    if (none && !confirm("This repo has no build checks, so nothing verified this change. Merge anyway?")) return;
    if (!none && !confirm("Merge this pull request into your main branch? It will sync back into Lovable.")) return;
    run(f.merge({ data: { id: p.id, acceptNoChecks: none } }));
  };

  return (
    <li className="panel p-4 text-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">{p.owner_projects?.name ?? "Project"} · {new Date(p.created_at).toLocaleString()} · {p.trigger === "scheduled" ? "scheduled" : "on demand"}{p.edited ? " · edited" : ""}</div>
        <div className="flex items-center gap-3 text-xs">{chk && <span className={chk[1]}>{chk[0]}</span>}<span className={`font-semibold ${COLOR[p.status]}`}>{STATUS_LABEL[p.status]}</span></div>
      </div>
      {p.delivery_error && <p className="mb-2 text-xs text-destructive">{p.delivery_error}</p>}
      {editing ? (
        <div className="grid gap-2">
          <input aria-label="Title" className={input} value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
          <textarea aria-label="What to change" className={`${input} min-h-20`} value={d.what_to_change} onChange={(e) => setD({ ...d, what_to_change: e.target.value })} />
          <textarea aria-label="Why" className={`${input} min-h-16`} value={d.why} onChange={(e) => setD({ ...d, why: e.target.value })} />
          <textarea aria-label="Build prompt" className={`${input} min-h-40 font-mono text-xs`} value={d.build_prompt} onChange={(e) => setD({ ...d, build_prompt: e.target.value })} />
          <div className="flex gap-2"><button className={btn} onClick={() => { act(f.edit({ data: { id: p.id, ...d } })); setEditing(false); }}>Save</button><button className={btn} onClick={() => setEditing(false)}>Cancel</button></div>
        </div>
      ) : (
        <>
          <h3 className="text-base font-semibold">{p.title}</h3>
          <p className="mt-2 whitespace-pre-line"><span className="text-silver">What to change: </span>{p.what_to_change}</p>
          <p className="mt-2 whitespace-pre-line text-muted-foreground"><span className="text-silver">Why: </span>{p.why}</p>
          {p.files.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-electric">Code changes ({p.files.length} file{p.files.length > 1 ? "s" : ""})</summary>
              {p.files.map((x) => (
                <div key={x.path} className="mt-2">
                  <div className="font-mono text-xs">{x.path} {x.isNew && <span className="text-success">(new)</span>}</div>
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs">{x.content}</pre>
                </div>
              ))}
            </details>
          )}
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-electric">Build prompt for OMNI</summary>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{p.build_prompt}</pre>
          </details>
        </>
      )}
      {!editing && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className={btn} onClick={copy}>{copied ? "Copied" : "Copy build prompt"}</button>
          {["draft", "approved", "rejected"].includes(p.status) && <button className={btn} onClick={() => setEditing(true)}>Edit</button>}
          {p.status === "draft" && p.files.length > 0 && p.owner_projects?.github_repo && <button className={btn} disabled={busy} onClick={() => run(f.open({ data: { id: p.id } }))}>Open pull request</button>}
          {p.pr_url && <a href={p.pr_url} target="_blank" rel="noreferrer" className={btn}>View PR #{p.pr_number}</a>}
          {p.status === "pr_open" && <button className={btn} disabled={busy} onClick={() => run(f.checks({ data: { id: p.id } }))}>Refresh build status</button>}
          {p.status === "pr_open" && <button className={`${btn} text-success`} disabled={busy || p.checks_state === "failure" || p.checks_state === "pending"} onClick={merge} title={p.checks_state === "failure" ? "Build failed" : p.checks_state === "pending" ? "Wait for build" : ""}>Approve &amp; merge</button>}
          {p.status === "merged" && <button className={`${btn} text-destructive`} disabled={busy} onClick={() => { if (confirm("Revert this update? Jackboy restores the previous file contents via a new PR and merges it.")) run(f.revert({ data: { id: p.id } })); }}>Revert</button>}
          {p.revert_pr_url && <a href={p.revert_pr_url} target="_blank" rel="noreferrer" className={btn}>Revert PR</a>}
          {can("approved") && <button className={`${btn} text-success`} onClick={() => act(f.status({ data: { id: p.id, status: "approved" } }))}>Approve</button>}
          {can("rejected") && <button className={`${btn} text-destructive`} disabled={busy} onClick={() => run(f.status({ data: { id: p.id, status: "rejected" } }))}>{p.status === "pr_open" ? "Reject & close PR" : "Reject"}</button>}
          {can("sent_to_omni") && <button className={btn} onClick={() => act(f.status({ data: { id: p.id, status: "sent_to_omni" } }))} title="Mark after you've pasted the prompt into OMNI">Mark sent to OMNI</button>}
          {can("draft") && <button className={btn} onClick={() => act(f.status({ data: { id: p.id, status: "draft" } }))}>Back to draft</button>}
        </div>
      )}
    </li>
  );
}

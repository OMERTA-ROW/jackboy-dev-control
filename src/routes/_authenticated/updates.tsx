import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { canTransition, FREQUENCIES, STATUS_LABEL, STATUSES, type ProposalStatus } from "@/lib/update-writer";
import { editProposal, getQueue, runNow, setFrequency, setProposalStatus } from "@/lib/update-writer.functions";

export const Route = createFileRoute("/_authenticated/updates")({
  head: () => ({
    meta: [
      { title: "Update Queue — Jackboy" },
      { name: "description", content: "Review, edit, approve or reject AI-written update proposals for your projects." },
      { property: "og:title", content: "Update Queue — Jackboy" },
      { property: "og:description", content: "Owner review queue for Jackboy update proposals and OMNI build prompts." },
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
const COLOR: Record<ProposalStatus, string> = { draft: "text-silver", approved: "text-success", rejected: "text-destructive", sent_to_omni: "text-electric" };

function Updates() {
  const f = { load: useServerFn(getQueue), run: useServerFn(runNow), freq: useServerFn(setFrequency), status: useServerFn(setProposalStatus), edit: useServerFn(editProposal) };
  const [q, setQ] = useState<Q | null>(null);
  const [filter, setFilter] = useState<ProposalStatus | "all">("draft");
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const refresh = useCallback(() => f.load().then(setQ).catch((e) => setErr((e as Error).message)), [f.load]);
  useEffect(() => { refresh(); }, [refresh]);
  const act = async (p: Promise<unknown>) => { setErr(null); try { await p; await refresh(); } catch (e) { setErr((e as Error).message); } };

  const runAll = async () => {
    setRunning(true); setErr(null); setMsg(null);
    try { const r = await f.run({ data: {} }); setMsg(r.skipped ? `Skipped: ${r.skipped}` : `${r.created} proposal(s) written.${r.errors.length ? ` Problems: ${r.errors.join("; ")}` : ""}`); await refresh(); }
    catch (e) { setErr((e as Error).message); } finally { setRunning(false); }
  };

  if (!q) return <><PageHeader title="Update Queue" subtitle="Loading…" />{err && <p className="text-sm text-destructive">{err}</p>}</>;
  const s = q.settings;
  const shown = q.proposals.filter((p) => filter === "all" || p.status === filter);

  return (
    <>
      <PageHeader title="Update Queue" subtitle="Jackboy writes one update proposal per project from its goals and notes. Nothing is sent anywhere automatically — you copy approved prompts into OMNI." />
      {err && <p role="alert" className="mb-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive">{err}</p>}
      {msg && <p aria-live="polite" className="mb-4 rounded-md border border-border p-3 text-sm">{msg}</p>}

      <section className="panel mb-6 flex flex-col gap-3 p-4 text-sm md:flex-row md:items-center md:justify-between">
        <div>
          <div className="font-semibold">Schedule: {FREQUENCIES.find((x) => x.hours === s?.frequency_hours)?.label ?? "—"}</div>
          <div className="text-xs text-muted-foreground">Last run: {s?.last_run_at ? new Date(s.last_run_at).toLocaleString() : "never"} · Up to 5 projects per run, least recently updated first.</div>
          {s?.paused_reason && <div className="mt-1 text-xs text-destructive">Scheduled runs paused: {s.paused_reason}</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Frequency" value={s?.frequency_hours ?? 24} onChange={(e) => act(f.freq({ data: { hours: Number(e.target.value) as 24 } }))} className="rounded-md border border-input bg-background px-2 py-1.5 text-xs">
            {FREQUENCIES.map((x) => <option key={x.hours} value={x.hours}>{x.label}</option>)}
          </select>
          {s?.paused_reason && <button className={btn} onClick={() => act(f.freq({ data: { hours: s.frequency_hours as 24, clearPause: true } }))}>Resume schedule</button>}
          <button className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50" disabled={running} onClick={runAll}>{running ? "Writing updates…" : "Run now"}</button>
        </div>
      </section>

      <div className="mb-4 flex flex-wrap gap-2" role="tablist">
        {(["all", ...STATUSES] as const).map((k) => (
          <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)} className={`${btn} ${filter === k ? "border-electric text-electric" : ""}`}>
            {k === "all" ? "All" : STATUS_LABEL[k]} ({k === "all" ? q.proposals.length : q.proposals.filter((p) => p.status === k).length})
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="panel p-4 text-sm text-muted-foreground">No proposals here. {q.proposals.length === 0 && <>Add projects on the <Link to="/projects" className="text-electric underline">Projects</Link> page, then press Run now.</>}</p>
      ) : (
        <ul className="space-y-4">{shown.map((p) => <ProposalCard key={p.id} p={p} onStatus={(st) => act(f.status({ data: { id: p.id, status: st } }))} onSave={(d) => act(f.edit({ data: { id: p.id, ...d } }))} />)}</ul>
      )}

      <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wider text-silver">Audit log</h2>
      <ul className="panel space-y-1 p-4 font-mono text-xs">
        {q.log.length === 0 && <li className="text-muted-foreground">Nothing yet.</li>}
        {q.log.map((l) => <li key={l.id}>{new Date(l.at).toLocaleString()} · {l.action} · <span className={l.outcome === "ok" ? "" : "text-destructive"}>{l.outcome}</span>{typeof l.detail["name"] === "string" ? ` · ${l.detail["name"]}` : typeof l.detail["title"] === "string" ? ` · ${l.detail["title"]}` : ""}</li>)}
      </ul>
    </>
  );
}

function ProposalCard({ p, onStatus, onSave }: { p: Prop; onStatus: (s: ProposalStatus) => void; onSave: (d: { title: string; what_to_change: string; why: string; build_prompt: string }) => void }) {
  const [editing, setEditing] = useState(false);
  const [d, setD] = useState({ title: p.title, what_to_change: p.what_to_change, why: p.why, build_prompt: p.build_prompt });
  const [copied, setCopied] = useState(false);
  const copy = async () => { await navigator.clipboard.writeText(p.build_prompt); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  const can = (t: ProposalStatus) => canTransition(p.status, t);

  return (
    <li className="panel p-4 text-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">{p.owner_projects?.name ?? "Project"} · {new Date(p.created_at).toLocaleString()} · {p.trigger === "scheduled" ? "scheduled" : "on demand"}{p.edited ? " · edited" : ""}</div>
        <span className={`text-xs font-semibold ${COLOR[p.status]}`}>{STATUS_LABEL[p.status]}</span>
      </div>
      {editing ? (
        <div className="grid gap-2">
          <input aria-label="Title" className={input} value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
          <textarea aria-label="What to change" className={`${input} min-h-20`} value={d.what_to_change} onChange={(e) => setD({ ...d, what_to_change: e.target.value })} />
          <textarea aria-label="Why" className={`${input} min-h-16`} value={d.why} onChange={(e) => setD({ ...d, why: e.target.value })} />
          <textarea aria-label="Build prompt" className={`${input} min-h-40 font-mono text-xs`} value={d.build_prompt} onChange={(e) => setD({ ...d, build_prompt: e.target.value })} />
          <div className="flex gap-2"><button className={btn} onClick={() => { onSave(d); setEditing(false); }}>Save</button><button className={btn} onClick={() => setEditing(false)}>Cancel</button></div>
        </div>
      ) : (
        <>
          <h3 className="text-base font-semibold">{p.title}</h3>
          <p className="mt-2 whitespace-pre-line"><span className="text-silver">What to change: </span>{p.what_to_change}</p>
          <p className="mt-2 whitespace-pre-line text-muted-foreground"><span className="text-silver">Why: </span>{p.why}</p>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-electric">Build prompt for OMNI</summary>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{p.build_prompt}</pre>
          </details>
        </>
      )}
      {!editing && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button className={btn} onClick={copy}>{copied ? "Copied" : "Copy build prompt"}</button>
          {p.status !== "sent_to_omni" && <button className={btn} onClick={() => setEditing(true)}>Edit</button>}
          {can("approved") && <button className={`${btn} text-success`} onClick={() => onStatus("approved")}>Approve</button>}
          {can("rejected") && <button className={`${btn} text-destructive`} onClick={() => onStatus("rejected")}>Reject</button>}
          {can("sent_to_omni") && <button className={btn} onClick={() => onStatus("sent_to_omni")} title="Mark after you've pasted the prompt into OMNI">Mark sent to OMNI</button>}
          {can("draft") && <button className={btn} onClick={() => onStatus("draft")}>Back to draft</button>}
          {p.owner_projects?.lovable_url && <a href={p.owner_projects.lovable_url} target="_blank" rel="noreferrer" className={btn}>Open project</a>}
        </div>
      )}
    </li>
  );
}

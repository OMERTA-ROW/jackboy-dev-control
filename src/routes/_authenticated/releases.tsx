import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { UpdateTargets } from "@/components/UpdateTargets";
import { supabase } from "@/integrations/supabase/client";
import { CHANNELS } from "@/lib/update-server";
import { changeRelease, createRelease, deleteDraft, deleteFlag, getReleaseData, publishRelease, saveFlag, type FlagRow, type ReleaseRow } from "@/lib/releases.functions";

export const Route = createFileRoute("/_authenticated/releases")({
  head: () => ({
    meta: [
      { title: "Releases — Jackboy" },
      { name: "description", content: "Signed versions, staged rollouts, feature flags and health-based rollback for each project." },
      { property: "og:title", content: "Releases — Jackboy" },
      { property: "og:description", content: "Owner-only update server: versions, channels, rollouts, flags and health." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Releases,
});

const input = "rounded-md border border-input bg-background px-3 py-2 text-sm";
const btn = "rounded-md border border-border px-3 py-1.5 text-xs hover:border-electric disabled:opacity-40";
type Data = Awaited<ReturnType<typeof getReleaseData>>;
const emptyRel = { version: "", channel: "test" as (typeof CHANNELS)[number], notes: "", config: "", rollout_percent: 10, auto_step: 10, step_hours: 24, error_threshold: 5, min_reports: 20 };
const statusTone: Record<string, string> = { draft: "text-muted-foreground", rolling: "text-electric", paused: "text-silver", complete: "text-emerald", rolled_back: "text-destructive" };

function Releases() {
  const load = useServerFn(getReleaseData), create = useServerFn(createRelease), publish = useServerFn(publishRelease), change = useServerFn(changeRelease), delDraft = useServerFn(deleteDraft), flagSave = useServerFn(saveFlag), flagDel = useServerFn(deleteFlag);
  const [d, setD] = useState<Data | null>(null);
  const [pid, setPid] = useState("");
  const [form, setForm] = useState(emptyRel);
  const [file, setFile] = useState<File | null>(null);
  const [flag, setFlag] = useState({ key: "", channel: "live" as (typeof CHANNELS)[number], enabled: false, rollout_percent: 100, description: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(() => load().then((r) => { setD(r); setPid((p) => p || r.projects[0]?.id || ""); }).catch((e) => setErr((e as Error).message)), [load]);
  useEffect(() => { refresh(); }, [refresh]);
  const act = async (key: string, fn: () => Promise<unknown>) => { setBusy(key); setErr(null); try { await fn(); await refresh(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); } };

  const project = d?.projects.find((p) => p.id === pid);
  const releases = useMemo(() => (d?.releases ?? []).filter((r) => r.project_id === pid), [d, pid]);
  const flags = useMemo(() => (d?.flags ?? []).filter((f) => f.project_id === pid), [d, pid]);

  const submit = (e: React.FormEvent) => { e.preventDefault(); act("create", async () => {
    let artifact_path: string | null = null;
    if (file) {
      const name = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120);
      artifact_path = `${pid}/${crypto.randomUUID().slice(0, 8)}-${name}`.replace(/^([0-9a-f-]{36})\/([0-9a-f]{8})-/, "$1/$2-");
      const { error } = await supabase.storage.from("release-artifacts").upload(artifact_path, file, { upsert: false });
      if (error) throw new Error(`Upload failed: ${error.message}`);
    }
    await create({ data: { ...form, project_id: pid, artifact_path } });
    setForm(emptyRel); setFile(null);
  }); };

  if (!d) return <div className="p-6 text-sm text-muted-foreground">{err ?? "Loading releases…"}</div>;
  return (
    <div className="space-y-6">
      <PageHeader title="Releases" subtitle="Signed versions per channel, staged rollouts, remote feature flags and automatic rollback on errors." />
      {err && <p role="alert" className="rounded-md border border-destructive/50 p-3 text-sm text-destructive">{err}</p>}
      <section className="hex-panel rounded-lg border border-border p-4 text-sm space-y-1">
        <p>Signing: {d.publicKey ? <span className="text-emerald">Ed25519 key active</span> : <span className="text-destructive">not configured</span>}</p>
        {d.publicKey && <p className="break-all font-mono text-xs text-muted-foreground">Public key: {d.publicKey}</p>}
        <p className="text-muted-foreground">Copy-paste client code is on <Link to="/update-docs" className="text-electric underline">Update client docs</Link>.</p>
      </section>

      {d.projects.length === 0 ? <p className="text-sm text-muted-foreground">Add a project on <Link to="/projects" className="text-electric underline">Projects</Link> first.</p> : (<>
        <label className="flex flex-wrap items-center gap-2 text-sm">Project
          <select className={input} value={pid} onChange={(e) => setPid(e.target.value)}>{d.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          {project && <code className="text-xs text-muted-foreground">client key: {project.client_key}</code>}
        </label>
        {pid && <UpdateTargets projectId={pid} />}

        <form onSubmit={submit} className="hex-panel grid gap-3 rounded-lg border border-border p-4 sm:grid-cols-2">
          <h2 className="sm:col-span-2 font-semibold">New release (saved as draft)</h2>
          <label className="grid gap-1 text-xs">Version<input required className={input} placeholder="1.4.0" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} /></label>
          <label className="grid gap-1 text-xs">Channel<select className={input} value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as typeof form.channel })}>{CHANNELS.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="sm:col-span-2 grid gap-1 text-xs">Release notes<textarea className={input} rows={3} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
          <label className="sm:col-span-2 grid gap-1 text-xs">Config (optional JSON shipped in the manifest)<textarea className={`${input} font-mono`} rows={3} placeholder='{"apiBase":"https://…"}' value={form.config} onChange={(e) => setForm({ ...form, config: e.target.value })} /></label>
          <label className="sm:col-span-2 grid gap-1 text-xs">Bundle file (optional, max 50 MB)<input type="file" className="text-xs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          {([["rollout_percent", "Start at % of devices"], ["auto_step", "Auto-increase by % (0 = manual)"], ["step_hours", "…every N hours"], ["error_threshold", "Rollback if error rate ≥ %"], ["min_reports", "…after at least N reports"]] as const).map(([k, l]) => (
            <label key={k} className="grid gap-1 text-xs">{l}<input type="number" step={k === "error_threshold" ? "0.1" : "1"} className={input} value={form[k]} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} /></label>
          ))}
          <div className="sm:col-span-2"><button disabled={busy === "create"} className={btn}>{busy === "create" ? "Saving…" : "Save draft"}</button></div>
        </form>

        <section className="space-y-3">
          <h2 className="font-semibold">Version history</h2>
          {releases.length === 0 && <p className="text-sm text-muted-foreground">No releases yet for this project.</p>}
          {releases.map((r) => <ReleaseCard key={r.id} r={r} h={d.health[r.id]} busy={busy} act={act} publish={publish} change={change} del={delDraft} />)}
        </section>

        <section className="hex-panel space-y-3 rounded-lg border border-border p-4">
          <h2 className="font-semibold">Feature flags</h2>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); act("flag", () => flagSave({ data: { ...flag, project_id: pid } }).then(() => setFlag({ ...flag, key: "", description: "" }))); }}>
            <input required className={input} placeholder="flag_key" value={flag.key} onChange={(e) => setFlag({ ...flag, key: e.target.value })} />
            <select className={input} value={flag.channel} onChange={(e) => setFlag({ ...flag, channel: e.target.value as typeof flag.channel })}>{CHANNELS.map((c) => <option key={c}>{c}</option>)}</select>
            <label className="text-xs">% <input type="number" min={0} max={100} className={`${input} w-20`} value={flag.rollout_percent} onChange={(e) => setFlag({ ...flag, rollout_percent: Number(e.target.value) })} /></label>
            <input className={input} placeholder="description" value={flag.description} onChange={(e) => setFlag({ ...flag, description: e.target.value })} />
            <button className={btn} disabled={busy === "flag"}>Add flag</button>
          </form>
          {flags.length === 0 ? <p className="text-sm text-muted-foreground">No flags.</p> : (
            <ul className="divide-y divide-border text-sm">{flags.map((f: FlagRow) => (
              <li key={f.id} className="flex flex-wrap items-center gap-3 py-2">
                <code>{f.key}</code><span className="text-xs text-muted-foreground">{f.channel} · {f.rollout_percent}%</span>
                <span className="flex-1 text-xs text-muted-foreground">{f.description}</span>
                <button className={btn} aria-pressed={f.enabled} onClick={() => act(f.id, () => flagSave({ data: { project_id: f.project_id, channel: f.channel as "live", key: f.key, enabled: !f.enabled, rollout_percent: f.rollout_percent, description: f.description } }))}>
                  <span className={f.enabled ? "text-emerald" : "text-muted-foreground"}>{f.enabled ? "On" : "Off"}</span></button>
                <button className={btn} onClick={() => act(f.id, () => flagDel({ data: { id: f.id } }))}>Delete</button>
              </li>))}</ul>)}
        </section>
      </>)}
    </div>
  );
}

function ReleaseCard({ r, h, busy, act, publish, change, del }: { r: ReleaseRow; h: { total: number; failures: number } | undefined; busy: string | null; act: (k: string, f: () => Promise<unknown>) => void; publish: any; change: any; del: any }) {
  const [pct, setPct] = useState(r.rollout_percent);
  const rate = h && h.total ? ((h.failures / h.total) * 100).toFixed(1) : null;
  const go = (action: string, extra = {}) => act(r.id, () => change({ data: { id: r.id, action, ...extra } }));
  return (
    <article className="hex-panel rounded-lg border border-border p-4 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <strong className="font-mono">{r.version}</strong><span className="rounded border border-border px-2 text-xs">{r.channel}</span>
        <span className={`text-xs ${statusTone[r.status] ?? ""}`}>{r.status.replace("_", " ")}</span>
        <span className="text-xs text-muted-foreground">{r.rollout_percent}% of devices</span>
        {r.signature && <span className="text-xs text-emerald">signed</span>}
        <span className="ml-auto text-xs text-muted-foreground">{new Date(r.published_at ?? r.created_at).toLocaleString()}</span>
      </div>
      {r.notes && <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{r.notes}</p>}
      <p className="mt-2 text-xs text-muted-foreground">
        Health (30d): {h ? `${h.failures}/${h.total} failed${rate ? ` (${rate}%)` : ""}` : "no reports"} · rollback at ≥{r.error_threshold}% after {r.min_reports} reports
        {r.auto_step > 0 ? ` · +${r.auto_step}% every ${r.step_hours}h` : " · manual rollout"}
        {r.artifact_sha256 && ` · bundle sha256 ${r.artifact_sha256.slice(0, 12)}…`}
      </p>
      {r.rollback_reason && <p className="mt-1 text-xs text-destructive">{r.rollback_reason}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {r.status === "draft" && <><button className={btn} disabled={busy === r.id} onClick={() => act(r.id, () => publish({ data: { id: r.id } }))}>Sign & start rollout</button><button className={btn} onClick={() => act(r.id, () => del({ data: { id: r.id } }))}>Delete draft</button></>}
        {["draft", "rolling", "paused"].includes(r.status) && <label className="flex items-center gap-1 text-xs">Rollout %<input type="number" min={0} max={100} className={`${input} w-20 py-1`} value={pct} onChange={(e) => setPct(Number(e.target.value))} /><button className={btn} onClick={() => go("percent", { percent: pct })}>Set</button></label>}
        {r.status === "rolling" && <button className={btn} onClick={() => go("pause")}>Pause</button>}
        {r.status === "paused" && <button className={btn} onClick={() => go("resume")}>Resume</button>}
        {["rolling", "paused"].includes(r.status) && <button className={btn} onClick={() => go("complete")}>Release to 100%</button>}
        {["rolling", "paused", "complete"].includes(r.status) && <button className={`${btn} text-destructive`} onClick={() => confirm(`Roll back ${r.version}? Devices revert to the previous release.`) && go("rollback")}>Roll back</button>}
      </div>
    </article>
  );
}

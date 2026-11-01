import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { FREQUENCIES } from "@/lib/update-writer";
import { connectAndScan } from "@/lib/autopilot.functions";
import { deleteProject, getProjects, runNow, saveProject, testRepo, type ProjectRow } from "@/lib/update-writer.functions";

export const Route = createFileRoute("/_authenticated/projects")({
  head: () => ({
    meta: [
      { title: "Projects — Jackboy" },
      { name: "description", content: "Owner registry of projects Jackboy writes and delivers updates for." },
      { property: "og:title", content: "Projects — Jackboy" },
      { property: "og:description", content: "Each project's link, goals, private GitHub repo and update schedule." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Projects,
});

const empty = { name: "", lovable_url: "", site_url: "", description: "", goals: "", notes: "", github_repo: "", github_branch: "main", frequency_hours: 24, active: true };
const input = "rounded-md border border-input bg-background px-3 py-2 text-sm";
const btn = "rounded-md border border-border px-3 py-1.5 text-xs hover:border-electric disabled:opacity-40";

function Projects() {
  const load = useServerFn(getProjects), save = useServerFn(saveProject), del = useServerFn(deleteProject), run = useServerFn(runNow), test = useServerFn(testRepo), onboard = useServerFn(connectAndScan);
  const [list, setList] = useState<ProjectRow[] | null>(null);
  const [gh, setGh] = useState(false);
  const [form, setForm] = useState<typeof empty & { id?: string }>(empty);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(() => load().then((r) => { setList(r.projects); setGh(r.githubConfigured); }).catch((e) => setErr((e as Error).message)), [load]);
  useEffect(() => { refresh(); }, [refresh]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    try {
      const r = await save({ data: form }); setForm(empty); await refresh();
      if (r.created) {
        setBusy(r.id); setMsg("Project added. Jackboy is connecting it and scanning the site…");
        try { const o = await onboard({ data: { id: r.id } }); setMsg(`Done — ${o.steps.join(" · ")}`); } catch (x) { setErr((x as Error).message); } finally { setBusy(null); await refresh(); }
      }
    } catch (x) { setErr((x as Error).message); }
  };
  const generate = async (id: string) => {
    setBusy(id); setErr(null); setMsg(null);
    try { const r = await run({ data: { projectId: id } }); setMsg(r.skipped ? `Skipped: ${r.skipped}` : r.created ? `Update written.${r.errors.length ? ` ${r.errors.join("; ")}` : ""}` : `Failed: ${r.errors.join("; ")}`); await refresh(); }
    catch (x) { setErr((x as Error).message); } finally { setBusy(null); }
  };

  return (
    <>
      <PageHeader title="Projects" subtitle="Your projects, their goals and private GitHub repos. Jackboy reads these plus your feeds to write code updates." />
      {!gh && <p className="mb-4 rounded-md border border-border p-3 text-xs text-muted-foreground">GitHub is not connected yet — updates are written as ideas and build prompts only. Add the <span className="font-mono">GITHUB_TOKEN</span> secret to enable pull requests.</p>}
      {err && <p role="alert" className="mb-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive">{err}</p>}
      {msg && <p aria-live="polite" className="mb-4 rounded-md border border-border p-3 text-sm">{msg} <Link to="/updates" className="text-electric underline">Open queue</Link></p>}

      <form onSubmit={submit} className="panel mb-6 grid gap-2 p-4 md:grid-cols-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-silver md:col-span-2">{form.id ? "Edit project" : "Add project"}</h2>
        <input required aria-label="Name" placeholder="Project name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} />
        <input aria-label="Live site URL" placeholder="Live site: https://…" value={form.site_url} onChange={(e) => setForm({ ...form, site_url: e.target.value })} className={input} />
        <input aria-label="Lovable project link" placeholder="https://lovable.dev/projects/…" value={form.lovable_url} onChange={(e) => setForm({ ...form, lovable_url: e.target.value })} className={input} />
        <textarea aria-label="Description" placeholder="Short description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={`${input} min-h-16 md:col-span-2`} />
        <textarea aria-label="Goals" placeholder="Goals (one per line)" value={form.goals} onChange={(e) => setForm({ ...form, goals: e.target.value })} className={`${input} min-h-20`} />
        <textarea aria-label="Recent notes" placeholder="Recent notes: what changed, what's broken, feedback" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={`${input} min-h-20`} />
        <div className="flex gap-2">
          <input aria-label="GitHub repo" placeholder="Private repo: owner/repo" value={form.github_repo} onChange={(e) => setForm({ ...form, github_repo: e.target.value })} className={`${input} flex-1`} />
          <input aria-label="Branch" placeholder="main" value={form.github_branch} onChange={(e) => setForm({ ...form, github_branch: e.target.value })} className={`${input} w-28`} />
          <button type="button" className={btn} disabled={!form.github_repo} onClick={() => test({ data: { repo: form.github_repo } }).then((r) => (r.ok ? setMsg(r.message) : setErr(r.message)))}>Test</button>
        </div>
        <select aria-label="Update frequency" value={form.frequency_hours} onChange={(e) => setForm({ ...form, frequency_hours: Number(e.target.value) })} className={input}>
          {FREQUENCIES.map((f) => <option key={f.hours} value={f.hours}>{f.label}</option>)}
        </select>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Include in scheduled updates</label>
        <div className="flex justify-end gap-2">
          {form.id && <button type="button" className={btn} onClick={() => setForm(empty)}>Cancel</button>}
          <button className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">{form.id ? "Save changes" : "Add project"}</button>
        </div>
      </form>

      {!list ? <p className="text-sm text-muted-foreground">Loading…</p> : list.length === 0 ? <p className="text-sm text-muted-foreground">No projects yet. Add one above.</p> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {list.map((p) => (
            <li key={p.id} className="panel p-4 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{p.name} {!p.active && <span className="text-xs text-muted-foreground">(not scheduled)</span>}</div>
                  <div className="text-xs text-muted-foreground">{p.github_repo ? <span className="font-mono">{p.github_repo}@{p.github_branch}</span> : "No repo — ideas only"} · {FREQUENCIES.find((f) => f.hours === p.frequency_hours)?.label}</div>
                  {p.lovable_url && <a href={p.lovable_url} target="_blank" rel="noreferrer" className="text-xs text-electric underline">Open project</a>}
                </div>
                <span className="text-xs text-muted-foreground">{p.last_proposal_at ? `Last update ${new Date(p.last_proposal_at).toLocaleString()}` : "No updates yet"}</span>
              </div>
              {p.goals && <p className="mt-2 whitespace-pre-line text-xs"><span className="text-silver">Goals:</span> {p.goals}</p>}
              <div className="mt-3 flex gap-2">
                <button className={btn} disabled={busy !== null} onClick={() => generate(p.id)}>{busy === p.id ? "Writing…" : "Run now"}</button>
                <button className={btn} onClick={() => setForm({ id: p.id, name: p.name, lovable_url: p.lovable_url ?? "", site_url: p.site_url ?? "", description: p.description, goals: p.goals, notes: p.notes, github_repo: p.github_repo ?? "", github_branch: p.github_branch, frequency_hours: p.frequency_hours, active: p.active })}>Edit</button>
                <button className={btn} onClick={() => { if (confirm(`Delete ${p.name} and its proposals?`)) del({ data: { id: p.id } }).then(refresh).catch((x) => setErr(x.message)); }}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

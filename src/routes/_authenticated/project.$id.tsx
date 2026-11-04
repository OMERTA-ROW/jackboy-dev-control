import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { StatusPill, btn, field, primaryBtn } from "@/components/ProjectBits";
import { getProjectDetail } from "@/lib/project-hub.functions";
import { projectStatus } from "@/lib/project-hub";
import { fixScan, scanNow, setProjectAutopilot } from "@/lib/autopilot.functions";
import { deleteProject, runNow, saveProject } from "@/lib/update-writer.functions";
import { SiteConnection } from "@/components/SiteConnection";
import { ProjectConnection } from "@/components/ProjectConnection";
import { FindingsReview, Steps } from "@/components/FindingsReview";
import { FREQUENCIES, STATUS_LABEL, type ProposalStatus } from "@/lib/update-writer";

export const Route = createFileRoute("/_authenticated/project/$id")({
  head: () => ({
    meta: [
      { title: "Project — Jackboy" },
      { name: "description", content: "Connection health, last scan, findings, repairs and approvals for one project." },
      { property: "og:title", content: "Project — Jackboy" },
      { property: "og:description", content: "One project's health, scans and repairs." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Detail,
});

type D = Awaited<ReturnType<typeof getProjectDetail>>;

function Detail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const load = useServerFn(getProjectDetail), scan = useServerFn(scanNow), fix = useServerFn(fixScan), auto = useServerFn(setProjectAutopilot);
  const save = useServerFn(saveProject), del = useServerFn(deleteProject), run = useServerFn(runNow);
  const [d, setD] = useState<D | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const refresh = useCallback(() => load({ data: { id } }).then(setD).catch((e) => setErr((e as Error).message)), [load, id]);
  useEffect(() => { void refresh(); }, [refresh]);

  const act = async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setErr(""); setMsg("");
    try { setMsg(await fn()); await refresh(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  if (!d) return <p className="text-sm text-muted-foreground">{err || "Loading…"}</p>;
  const p = d.project;
  if (!p) return <p className="text-sm">Project not found. <Link to="/projects" className="text-electric underline">Back to Projects</Link></p>;
  const last = d.scans[0];
  const waiting = d.proposals.filter((x) => ["draft", "pr_open", "approved"].includes(x.status));

  return (
    <>
      <Link to="/projects" className="mb-2 inline-block text-xs text-electric">← Projects</Link>
      <PageHeader title={p.name} subtitle={p.site_url ?? "No site address yet — add one to enable scans."} />
      <Steps at={!last ? 1 : waiting.length ? 3 : last.findings.length ? 2 : 4} />
      {err && <p role="alert" className="mb-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive">{err}</p>}
      {msg && <p aria-live="polite" className="mb-4 rounded-md border border-border p-3 text-sm">{msg}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="panel p-5" aria-labelledby="health">
          <div className="flex items-center justify-between gap-2"><h2 id="health" className="font-semibold">Connection health</h2><StatusPill status={projectStatus(p, last)} /></div>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Site</dt><dd className="truncate">{p.site_url ?? "Not set"}</dd>
            <dt className="text-muted-foreground">Lovable</dt><dd className="truncate">{p.lovable_url ? <a href={p.lovable_url} target="_blank" rel="noreferrer" className="text-electric underline">Open in Lovable</a> : "Not linked"}</dd>
            <dt className="text-muted-foreground">Repo</dt><dd className="truncate">{p.github_repo ? `${p.github_repo}@${p.github_branch}` : "None"}{p.github_repo && !d.githubConfigured && " (GitHub not connected)"}</dd>
            <dt className="text-muted-foreground">Update client</dt><dd>{p.connect_state}{p.connect_pr_url && <> · <a href={p.connect_pr_url} target="_blank" rel="noreferrer" className="text-electric underline">PR</a></>}</dd>
            {p.connect_error && <><dt className="text-muted-foreground">Problem</dt><dd className="text-destructive">{p.connect_error}</dd></>}
          </dl>
          <label className="mt-4 flex items-center gap-2 text-sm">
            <input type="checkbox" checked={p.autopilot} disabled={busy !== null} onChange={(e) => act("auto", async () => { const on = e.target.checked; await auto({ data: { id: p.id, on, grantId: on ? await stepUp("autonomy_toggle", `autopilot:${p.id}`) : undefined } }); return `Autopilot ${on ? "on" : "off"} for this project. The main Autopilot switch must also be on.`; })} />
            Autopilot for this project
          </label>
          <div className="mt-4 flex flex-wrap gap-2">
            {p.site_url
              ? <button className={primaryBtn} disabled={busy !== null} aria-busy={busy === "scan"} onClick={() => act("scan", async () => { const r = await scan({ data: { id: p.id } }); return `Checked ${r.pages} page(s): ${r.findings} finding(s). ${r.findings ? "Review them below." : "Nothing to review."}`; })}>{busy === "scan" ? "Scanning…" : waiting.some((w) => w.status === "approved") || d.proposals.some((x) => x.status === "merged") ? "Scan again to verify" : "Scan & Review"}</button>
              : <button className={primaryBtn} onClick={() => setEdit(true)}>Add site address to scan</button>}
            <button className={btn} disabled={busy !== null} onClick={() => act("run", async () => { const r = await run({ data: { projectId: p.id } }); return r.skipped ? `Skipped: ${r.skipped}` : r.created ? "Update written to the approval queue." : `Failed: ${r.errors.join("; ")}`; })}>{busy === "run" ? "Writing…" : "Write update now"}</button>
            <button className={btn} onClick={() => setEdit((v) => !v)}>{edit ? "Close edit" : "Edit details"}</button>
          </div>
        </section>

        <ProjectConnection projectId={p.id} onChanged={() => void refresh()} />
        <SiteConnection p={p} onChanged={() => void refresh()} onEdit={() => setEdit(true)} />

        <section className="panel p-5 lg:col-span-2" aria-labelledby="scan">
          <h2 id="scan" className="font-semibold">Review last scan</h2>
          {!last ? <p className="mt-2 text-sm text-muted-foreground">Not scanned yet. Press <strong>Scan &amp; Review</strong> above.</p> : (
            <>
              <p className="mt-1 text-xs text-muted-foreground">{new Date(last.created_at).toLocaleString()} · {last.pages_checked} pages · {last.links_checked} links{last.avg_ms ? ` · avg ${last.avg_ms} ms` : ""}. Checks the page HTML only; screens built by JavaScript after loading may be missed.</p>
              {last.error && <p className="mt-2 text-sm text-destructive">{last.error}</p>}
              {last.findings.length === 0 ? <p className="mt-2 text-sm text-success">No issues found in this scan.</p> : (
                <>
                  <FindingsReview projectId={p.id} scan={last} onChanged={() => void refresh()} />
                  {last.findings.some((f) => f.severity !== "low" && f.kind !== "demo") && !last.fix_proposal_id && (
                    <button className={`${btn} mt-3`} disabled={busy !== null} onClick={() => act("fix", async () => { await fix({ data: { id: last.id } }); return "One combined repair written. Check it below or in Approvals."; })}>{busy === "fix" ? "Writing repair…" : "Repair all errors at once"}</button>
                  )}
                </>
              )}
            </>
          )}
        </section>
      </div>

      {edit && <EditForm p={p} onSave={(v) => act("save", async () => { await save({ data: { id: p.id, ...v } }); setEdit(false); return "Saved."; })} onDelete={() => { if (confirm(`Remove ${p.name} from Jackboy and delete its update proposals?`)) void del({ data: { id: p.id } }).then(() => navigate({ to: "/projects" })).catch((e) => setErr(e.message)); }} />}

      <section className="panel mt-4 p-5" aria-labelledby="repairs">
        <div className="flex items-center justify-between"><h2 id="repairs" className="font-semibold">Repairs and approvals</h2><Link to="/updates" className="text-xs text-electric">Open Update Queue →</Link></div>
        <p className="mt-1 text-xs text-muted-foreground">{waiting.length} waiting for your decision. Approve, edit or reject in the Update Queue.</p>
        {d.proposals.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No repairs or updates yet.</p> : (
          <ul className="mt-3 divide-y divide-border text-sm">
            {d.proposals.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{x.title}</span>
                <span className="text-xs text-muted-foreground">{STATUS_LABEL[x.status as ProposalStatus] ?? x.status}{x.checks_state ? ` · checks ${x.checks_state}` : ""}{x.pr_url && <> · <a href={x.pr_url} target="_blank" rel="noreferrer" className="text-electric underline">PR</a></>}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {d.scans.length > 1 && (
        <section className="panel mt-4 p-5"><h2 className="font-semibold">Scan history</h2>
          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">{d.scans.slice(1).map((s) => <li key={s.id}>{new Date(s.created_at).toLocaleString()} · {s.status} · {s.findings.length} finding(s)</li>)}</ul>
        </section>
      )}
    </>
  );
}

type EditVals = { name: string; site_url: string; lovable_url: string; github_repo: string; github_branch: string; description: string; goals: string; notes: string; frequency_hours: number; active: boolean };
function EditForm({ p, onSave, onDelete }: { p: D["project"] & {}; onSave: (v: EditVals) => void; onDelete: () => void }) {
  const [v, setV] = useState<EditVals>({ name: p.name, site_url: p.site_url ?? "", lovable_url: p.lovable_url ?? "", github_repo: p.github_repo ?? "", github_branch: p.github_branch, description: p.description, goals: p.goals, notes: p.notes, frequency_hours: p.frequency_hours, active: p.active });
  const t = (k: keyof EditVals, label: string, area = false) => (
    <label className="text-xs">{label}{area ? <textarea value={v[k] as string} onChange={(e) => setV({ ...v, [k]: e.target.value })} className={`${field} mt-1 min-h-16`} /> : <input value={v[k] as string} onChange={(e) => setV({ ...v, [k]: e.target.value })} className={`${field} mt-1`} />}</label>
  );
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave(v); }} className="panel mt-4 grid gap-3 p-5 sm:grid-cols-2">
      <h2 className="font-semibold sm:col-span-2">Edit details</h2>
      {t("name", "Name")}{t("site_url", "Live site address")}{t("lovable_url", "Lovable link")}{t("github_repo", "GitHub repo (owner/repo)")}{t("github_branch", "Branch")}
      <label className="text-xs">Update schedule<select value={v.frequency_hours} onChange={(e) => setV({ ...v, frequency_hours: Number(e.target.value) })} className={`${field} mt-1`}>{FREQUENCIES.map((f) => <option key={f.hours} value={f.hours}>{f.label}</option>)}</select></label>
      {t("description", "Description", true)}{t("goals", "Goals", true)}{t("notes", "Recent notes", true)}
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={v.active} onChange={(e) => setV({ ...v, active: e.target.checked })} /> Include in scheduled updates</label>
      <div className="flex justify-between gap-2 sm:col-span-2">
        <button type="button" onClick={onDelete} className={`${btn} text-destructive`}>Remove project</button>
        <button className={primaryBtn}>Save</button>
      </div>
    </form>
  );
}

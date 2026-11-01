import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { btn, field, primaryBtn } from "@/components/ProjectBits";
import { getProjectHub } from "@/lib/project-hub.functions";
import { lovableUrl } from "@/lib/project-hub";
import { MultiSelect } from "@/components/ConnectMultiSelect";
import { saveProject, testRepo } from "@/lib/update-writer.functions";
import { connectAndScan } from "@/lib/autopilot.functions";

export const Route = createFileRoute("/_authenticated/connect")({
  head: () => ({
    meta: [
      { title: "Connect Project — Jackboy" },
      { name: "description", content: "Pick a saved Lovable project or enter a site address to connect it to Jackboy." },
      { property: "og:title", content: "Connect Project — Jackboy" },
      { property: "og:description", content: "Simple three-step project connection." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Connect,
});

export type Hub = Awaited<ReturnType<typeof getProjectHub>>;

function Connect() {
  const load = useServerFn(getProjectHub), save = useServerFn(saveProject), test = useServerFn(testRepo), onboard = useServerFn(connectAndScan);
  const navigate = useNavigate();
  const [hub, setHub] = useState<Hub | null>(null);
  const [form, setForm] = useState({ name: "", lovable_url: "", site_url: "", github_repo: "", github_branch: "main" });
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { load().then(setHub).catch((e) => setErr((e as Error).message)); }, [load]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(""); setBusy(true);
    try {
      const r = await save({ data: { ...form, description: "", goals: "", notes: "", frequency_hours: 24, active: true } });
      setMsg("Connected. Checking the site now…");
      try { await onboard({ data: { id: r.id } }); } catch (x) { setErr(`Saved, but the first check failed: ${(x as Error).message}`); }
      navigate({ to: "/project/$id", params: { id: r.id } });
    } catch (x) { setErr((x as Error).message); setBusy(false); }
  };

  return (
    <>
      <PageHeader title="Connect Project" subtitle="1. Select projects  ·  2. Add a site address  ·  3. Link a private GitHub repo so Jackboy can code." />
      {err && <p role="alert" className="mb-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive">{err}</p>}
      {msg && <p aria-live="polite" className="mb-4 rounded-md border border-border p-3 text-sm">{msg}</p>}

      <MultiSelect hub={hub} onPick={(n, ref) => setForm((f) => ({ ...f, name: n, lovable_url: ref ? lovableUrl(ref) ?? "" : "" }))} reload={() => load().then(setHub)} />

      <form onSubmit={submit} className="panel grid gap-4 p-5">
        <div>
          <h2 className="font-semibold">2. Site address</h2>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="text-xs">Project name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`${field} mt-1`} /></label>
            <label className="text-xs">Live site address<input value={form.site_url} onChange={(e) => setForm({ ...form, site_url: e.target.value })} placeholder="https://…" className={`${field} mt-1`} /></label>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">Needed for scans. You can add it later.</p>
        </div>
        <div>
          <h2 className="font-semibold">3. Private GitHub repo <span className="text-xs font-normal text-muted-foreground">(optional)</span></h2>
          <div className="mt-2 flex flex-wrap gap-2">
            <input aria-label="GitHub repo" value={form.github_repo} onChange={(e) => setForm({ ...form, github_repo: e.target.value })} placeholder="owner/repo" className={`${field} min-w-0 flex-1`} />
            <input aria-label="Branch" value={form.github_branch} onChange={(e) => setForm({ ...form, github_branch: e.target.value })} className={`${field} w-28`} />
            <button type="button" className={btn} disabled={!form.github_repo} onClick={() => test({ data: { repo: form.github_repo } }).then((r) => (r.ok ? setMsg(r.message) : setErr(r.message)))}>Test repo</button>
          </div>
          {hub && !hub.githubConfigured && <p className="mt-1 text-xs text-muted-foreground">GitHub isn't connected yet, so code changes can't be delivered. Fix ideas still go to your approval queue.</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Link to="/projects" className={btn}>Cancel</Link>
          <button className={primaryBtn} disabled={busy}>{busy ? "Connecting…" : "Connect Project"}</button>
        </div>
      </form>
    </>
  );
}

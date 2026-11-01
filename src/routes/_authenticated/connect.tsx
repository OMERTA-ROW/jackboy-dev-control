import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Check, Search } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { btn, field, primaryBtn } from "@/components/ProjectBits";
import { getProjectHub } from "@/lib/project-hub.functions";
import { availableInventory, lovableUrl, searchByName } from "@/lib/project-hub";
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

const LOVABLE_CONNECT = "https://lovable.dev/connectors/lovable_account/connect?workspace=qTqTdBvij3LL2HnYLgG8";
type Hub = Awaited<ReturnType<typeof getProjectHub>>;

function Connect() {
  const load = useServerFn(getProjectHub), save = useServerFn(saveProject), test = useServerFn(testRepo), onboard = useServerFn(connectAndScan);
  const navigate = useNavigate();
  const [hub, setHub] = useState<Hub | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", lovable_url: "", site_url: "", github_repo: "", github_branch: "main" });
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { load().then(setHub).catch((e) => setErr((e as Error).message)); }, [load]);
  const choices = hub ? searchByName(availableInventory(hub.inventory, hub.projects), q) : [];

  const pick = (id: string, name: string, ref: string) => {
    setPicked(id);
    setForm((f) => ({ ...f, name, lovable_url: lovableUrl(ref) ?? "" }));
  };
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
      <PageHeader title="Connect Project" subtitle="1. Choose a project  ·  2. Add its site address  ·  3. Optionally add its private GitHub repo." />
      {err && <p role="alert" className="mb-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive">{err}</p>}
      {msg && <p aria-live="polite" className="mb-4 rounded-md border border-border p-3 text-sm">{msg}</p>}

      <section aria-labelledby="step1" className="panel mb-4 p-5">
        <h2 id="step1" className="font-semibold">1. Choose a project</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          These are the Lovable projects you saved to Jackboy earlier (a one-time list, not live). Pick one, or skip and type a name below.
        </p>
        {!hub ? <p className="mt-3 text-sm text-muted-foreground">Loading…</p> : (
          <>
            <label className="relative mt-3 block">
              <span className="sr-only">Search saved projects</span>
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search saved projects…" className={`${field} pl-9`} />
            </label>
            {choices.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No saved projects left to pick.</p> : (
              <ul role="listbox" aria-label="Saved Lovable projects" className="mt-3 grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
                {choices.map((c) => (
                  <li key={c.id}>
                    <button type="button" role="option" aria-selected={picked === c.id} onClick={() => pick(c.id, c.name, c.lovable_project_ref!)}
                      className={`flex w-full items-center justify-between gap-2 rounded-md border p-3 text-left text-sm ${picked === c.id ? "border-electric bg-accent/40" : "border-border hover:border-electric"}`}>
                      <span className="truncate">{c.name}</span>
                      {picked === c.id && <Check className="h-4 w-4 text-electric" aria-hidden />}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 rounded-md border border-border p-3 text-xs text-muted-foreground">
              {hub.lovableApiLinked ? (
                <>A Lovable account connection is linked, but live listing from it isn't built or tested yet, so only the saved list is shown.</>
              ) : (
                <>
                  <strong className="text-foreground">Live list of all your Lovable projects: not connected.</strong> It needs a Lovable account connection, and Lovable only allows it on Business or Enterprise plans.{" "}
                  <a href={LOVABLE_CONNECT} target="_blank" rel="noreferrer" className="text-electric underline">Set up Lovable connection</a>
                </>
              )}
            </div>
          </>
        )}
      </section>

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

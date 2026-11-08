import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { GuidanceTip, PageHeader } from "@/components/AppShell";
import {
  DEMON_CHECKS,
  ANGEL_KINDS,
  FORBIDDEN_ACTIONS,
  PERMISSIVE_LICENSES,
  agentProjectAnchor,
} from "@/lib/agent-hub";
import {
  addProject,
  createProposal,
  decideProposal,
  getHub,
  issueToken,
  revokeTokens,
  triageReport,
  updateProject,
} from "@/lib/agent-hub.functions";

export const Route = createFileRoute("/_authenticated/agents")({
  head: () => ({
    meta: [
      { title: "Agent Hub — Jackboy" },
      { name: "description", content: "Owner-controlled AngelTech and DemonTech agent coordination across enrolled projects." },
      { property: "og:title", content: "Agent Hub — Jackboy" },
      { property: "og:description", content: "Project registry, health ingestion, issue queue and owner-approved patch proposals." },
    ],
  }),
  component: AgentHub,
});

type Hub = Awaited<ReturnType<typeof getHub>>;
const btn = "rounded-md border border-border px-2.5 py-1 text-xs hover:border-electric disabled:opacity-40";
const SEV: Record<string, string> = { critical: "text-destructive", high: "text-destructive", medium: "text-warning", low: "text-silver", info: "text-muted-foreground" };

function AgentHub() {
  const load = useServerFn(getHub);
  const [hub, setHub] = useState<Hub | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [token, setToken] = useState<{ project: string; value: string } | null>(null);
  const [form, setForm] = useState({ name: "", lovable_project_ref: "", repo_url: "" });
  const fns = { add: useServerFn(addProject), upd: useServerFn(updateProject), issue: useServerFn(issueToken), revoke: useServerFn(revokeTokens), triage: useServerFn(triageReport), propose: useServerFn(createProposal), decide: useServerFn(decideProposal) };

  const refresh = useCallback(() => load().then(setHub).catch((e) => setErr((e as Error).message)), [load]);
  useEffect(() => { refresh(); }, [refresh]);
  const act = async (p: Promise<unknown>) => { setErr(null); try { await p; await refresh(); } catch (e) { setErr((e as Error).message); } };

  if (!hub) return <><PageHeader title="Agent Hub" subtitle="Loading…" />{err && <p className="text-destructive text-sm">{err}</p>}</>;
  const isOwner = hub.role === "owner";
  const manager = hub.role !== "member";
  const name = (id: string) => hub.projects.find((p) => p.id === id)?.name ?? "—";

  return (
    <>
      <PageHeader title="Agent Hub" subtitle="Projects join only when you enroll them. AngelTech gives diagnostics, research and code-quality feedback; DemonTech runs defensive security checks only, and only where you allow it." />
      <GuidanceTip>Jackboy can't see your other Lovable projects automatically. Add each one here, enroll it, and give it a one-time key so it can send reports.</GuidanceTip>
      {err && <p role="alert" className="mb-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive">{err}</p>}

      <section className="panel mb-6 grid gap-3 p-4 md:grid-cols-3 text-xs">
        <Status label="Report intake" state="ready" detail="Accepting reports from enrolled projects that have a valid key." />
        <Status label="OMNI" state={hub.omniConfigured ? "configured" : "off"} detail={hub.omniConfigured ? "Credentials present, not yet tested." : "Not connected. Needs OMNI_API_URL + OMNI_API_KEY."} />
        <Status label="Sandbox / pull requests" state="off" detail="No isolated test runner or GitHub connected. Proposals can't be marked tested or opened as PRs yet." />
      </section>

      {manager && (
        <form className="panel mb-6 flex flex-col gap-2 p-4 md:flex-row" onSubmit={(e) => { e.preventDefault(); act(fns.add({ data: form })).then(() => setForm({ name: "", lovable_project_ref: "", repo_url: "" })); }}>
          <input required aria-label="Project name" placeholder="Project name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm" />
          <input aria-label="Lovable project ID" placeholder="Lovable project ID (optional)" value={form.lovable_project_ref} onChange={(e) => setForm({ ...form, lovable_project_ref: e.target.value })} className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm" />
          <input aria-label="Repository URL" placeholder="Repo URL (optional)" value={form.repo_url} onChange={(e) => setForm({ ...form, repo_url: e.target.value })} className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm" />
          <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Add project</button>
        </form>
      )}

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Projects &amp; rollout ({hub.projects.length})</h2>
      {hub.projects.length === 0 && <p className="panel mb-6 p-4 text-sm text-muted-foreground">No projects registered yet.</p>}
      <div className="mb-6 grid gap-3 lg:grid-cols-2">
        {hub.projects.map((p) => (
          <article
            key={p.id}
            id={agentProjectAnchor(p.id)}
            className="panel scroll-mt-24 p-4 text-sm"
          >
            <div className="flex items-center justify-between"><span className="font-medium">{p.name}</span><span className="text-xs uppercase text-muted-foreground">{p.enrolled ? `enrolled · ${p.health}` : "not enrolled"}</span></div>
            <p className="mt-1 text-xs text-muted-foreground">{p.last_report_at ? `Last report ${new Date(p.last_report_at).toLocaleString()}` : "No reports received yet"}</p>
            <div className="mt-3 grid gap-2 text-xs">
              <Toggle label="Enrolled (opt-in)" checked={p.enrolled} disabled={!manager} onChange={(v) => act(fns.upd({ data: { id: p.id, enrolled: v } }))} />
              <Toggle label="AngelTech feedback" checked={p.angeltech_enabled} disabled={!manager} onChange={(v) => act(fns.upd({ data: { id: p.id, angeltech_enabled: v } }))} />
              <Toggle label="DemonTech defensive checks (owner only)" checked={p.demontech_enabled} disabled={!isOwner} onChange={(v) => act(fns.upd({ data: { id: p.id, demontech_enabled: v } }))} />
            </div>
            {isOwner && (
              <div className="mt-3 flex gap-2">
                <button className={btn} onClick={() => fns.issue({ data: { projectId: p.id } }).then((r) => setToken({ project: p.name, value: r.token })).catch((e) => setErr(e.message))}>Issue new key</button>
                <button className={btn} onClick={() => act(fns.revoke({ data: { projectId: p.id } }))}>Revoke keys</button>
              </div>
            )}
          </article>
        ))}
      </div>

      {token && (
        <section className="panel glow-electric mb-6 p-4 text-sm" aria-live="polite">
          <p className="font-medium">Key for {token.project} — shown once</p>
          <p className="text-xs text-muted-foreground">Store it as a secret in that project. It can only send reports; it can't read anything. Issuing a new key cancels the old one.</p>
          <code className="mt-2 block break-all rounded bg-muted p-2 font-mono text-xs">{token.value}</code>
          <pre className="mt-2 overflow-x-auto rounded bg-muted p-2 font-mono text-[11px]">{`POST /api/public/agent-ingest
Authorization: Bearer <key>
{"agent":"angeltech","kind":"code_quality","severity":"medium","title":"…","detail":"…","health":"ok"}`}</pre>
          <button className={`${btn} mt-2`} onClick={() => setToken(null)}>I've stored it</button>
        </section>
      )}

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Priority issue queue ({hub.queue.length})</h2>
      <ul className="mb-6 space-y-2">
        {hub.queue.length === 0 && <li className="panel p-4 text-sm text-muted-foreground">No open issues. Nothing has been reported yet.</li>}
        {hub.queue.map((r) => (
          <li key={r.id} className="panel flex flex-col gap-2 p-3 text-sm md:flex-row md:items-center md:justify-between">
            <div>
              <div className="flex gap-2 font-mono text-xs"><span className="text-electric">P{r.priority}</span><span className={SEV[r.severity]}>{r.severity}</span><span>{r.agent === "demontech" ? "DemonTech" : "AngelTech"} · {r.kind}</span><span className="text-muted-foreground">{name(r.project_id)}</span></div>
              <div className="mt-1">{r.title}</div>
              {r.detail && <div className="text-xs text-muted-foreground">{r.detail}</div>}
            </div>
            <div className="flex flex-wrap gap-2">
              {manager && r.status === "open" && <button className={btn} onClick={() => act(fns.triage({ data: { id: r.id, status: "acknowledged" } }))}>Acknowledge</button>}
              {manager && <button className={btn} onClick={() => act(fns.triage({ data: { id: r.id, status: "resolved" } }))}>Resolved</button>}
              {manager && <button className={btn} onClick={() => act(fns.triage({ data: { id: r.id, status: "dismissed" } }))}>Dismiss</button>}
              <button className={btn} onClick={() => act(fns.propose({ data: { projectId: r.project_id, reportId: r.id, title: `Fix: ${r.title}`, summary: r.detail, action: r.agent === "demontech" ? "sensitive_change" : "merge" } }))}>Draft fix proposal</button>
            </div>
          </li>
        ))}
      </ul>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Fix proposals — owner approval required</h2>
      <ul className="mb-6 space-y-2">
        {hub.proposals.length === 0 && <li className="panel p-4 text-sm text-muted-foreground">No proposals.</li>}
        {hub.proposals.map((p) => (
          <li key={p.id} className="panel flex flex-col gap-2 p-3 text-sm md:flex-row md:items-center md:justify-between">
            <div>
              <div className="font-mono text-xs"><span className="uppercase">{p.status}</span> · {p.action.replace("_", " ")} · {name(p.project_id)} · tests: {p.tests_passed ? "passed" : "not run (no sandbox)"}</div>
              <div className="mt-1">{p.title}</div>
            </div>
            {isOwner && p.status === "proposed" && (
              <div className="flex gap-2">
                <button className={btn} onClick={() => act(fns.decide({ data: { id: p.id, approve: true } }))}>Approve</button>
                <button className={btn} onClick={() => act(fns.decide({ data: { id: p.id, approve: false } }))}>Reject</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="mb-6 text-xs text-muted-foreground">Approving records your decision only. Nothing gets merged or deployed until code hosting, a test sandbox and OMNI are connected and tested.</p>

      <section className="panel grid gap-4 p-4 text-xs md:grid-cols-3">
        <div><h3 className="mb-1 font-semibold text-silver">AngelTech may report</h3><p className="text-muted-foreground">{ANGEL_KINDS.join(", ")}</p></div>
        <div><h3 className="mb-1 font-semibold text-silver">DemonTech defensive checks</h3><p className="text-muted-foreground">{DEMON_CHECKS.join(", ")}. Blocked always: {FORBIDDEN_ACTIONS.join(", ")}.</p></div>
        <div><h3 className="mb-1 font-semibold text-silver">Research reuse</h3><p className="text-muted-foreground">Code can be reused only with a source link and a known license. Allowed with credit: {PERMISSIVE_LICENSES.join(", ")}. Copyleft licenses need your review. Unknown licenses: never copied. Downloaded code is never run.</p></div>
      </section>
    </>
  );
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return <label className="flex items-center justify-between gap-3"><span>{label}</span><Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} /></label>;
}
function Status({ label, state, detail }: { label: string; state: "ready" | "configured" | "off"; detail: string }) {
  const c = state === "ready" ? "text-success" : state === "configured" ? "text-warning" : "text-muted-foreground";
  return <div><div className="font-semibold text-silver">{label} <span className={`uppercase ${c}`}>· {state === "off" ? "not connected" : state}</span></div><p className="text-muted-foreground">{detail}</p></div>;
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { ADAPTERS, CAPABILITIES, OWNER_ONLY, autonomousCapabilities, type AgentCategory, type Autonomy } from "@/lib/guardian";
import { approvePassport, getPassport, requestOmniJob, setJax, updateModel } from "@/lib/passport.functions";

export const Route = createFileRoute("/_authenticated/passport/$agentId")({
  head: () => ({
    meta: [
      { title: "Agent Passport — Jackboy" },
      { name: "description", content: "Identity, model, scope, health, feedback and audit trail for one Jackboy agent." },
      { property: "og:title", content: "Agent Passport — Jackboy" },
      { property: "og:description", content: "Owner-approved agent identity and Guardian scope." },
    ],
  }),
  component: Passport,
});

type Data = Awaited<ReturnType<typeof getPassport>>;
const btn = "rounded-md border border-border px-3 py-1.5 text-xs hover:border-electric disabled:opacity-40";
const input = "rounded-md border border-input bg-background px-3 py-2 text-sm";

function Passport() {
  const { agentId } = Route.useParams();
  const load = useServerFn(getPassport);
  const f = { model: useServerFn(updateModel), approve: useServerFn(approvePassport), jax: useServerFn(setJax), job: useServerFn(requestOmniJob) };
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [model, setModel] = useState({ adapter: "owner_agent" as "owner_agent" | "third_party" | "local", model_provider: "", model_name: "" });
  const [purpose, setPurpose] = useState("");

  const refresh = useCallback(() => load({ data: { id: agentId } }).then((x) => { setD(x); setModel({ adapter: x.agent.adapter as "owner_agent" | "third_party" | "local", model_provider: x.agent.model_provider, model_name: x.agent.model_name }); }).catch((e) => setErr((e as Error).message)), [load, agentId]);
  useEffect(() => { refresh(); }, [refresh]);
  const act = async (p: Promise<unknown>) => { setErr(null); try { await p; await refresh(); } catch (e) { setErr((e as Error).message); } };

  if (!d) return <><PageHeader title="Agent Passport" subtitle="Loading…" />{err && <p className="text-sm text-destructive">{err}</p>}</>;
  const a = d.agent;
  const owner = d.role === "owner";
  const manager = d.role !== "member";
  const caps = autonomousCapabilities(a.category as AgentCategory, a.autonomy as Autonomy);

  return (
    <>
      <Link to="/fleet" className="mb-3 inline-block text-xs text-muted-foreground hover:text-foreground">← Agent Fleet</Link>
      <PageHeader title={`Passport · ${a.name}`} subtitle="Who this agent is, what it may do, and everything it has done. Guardian refuses every action until you approve this passport." />
      {err && <p role="alert" className="mb-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive">{err}</p>}

      <section className={`panel mb-6 grid gap-4 p-4 text-sm md:grid-cols-3 ${a.passport_approved ? "border-success/50" : ""}`}>
        <Field k="Category" v={a.category === "demontech" ? "DemonTech (defensive security)" : "AngelTech (research & quality)"} />
        <Field k="Project" v={d.project?.name ?? "—"} />
        <Field k="Specialty" v={a.specialty || "—"} />
        <Field k="Autonomy" v={a.autonomy} />
        <Field k="Installed" v={a.installed_verified ? `verified · ${a.health}` : "not verified"} />
        <Field k="Last seen" v={a.last_seen_at ? new Date(a.last_seen_at).toLocaleString() : "never"} />
        <div className="md:col-span-3 flex flex-wrap items-center justify-between gap-2">
          <span className={a.passport_approved ? "font-semibold text-success" : "font-semibold text-warning"}>{a.passport_approved ? `Passport approved ${a.passport_approved_at ? new Date(a.passport_approved_at).toLocaleDateString() : ""}` : "Passport awaiting owner approval"}</span>
          {owner && <button className={btn} onClick={() => act(f.approve({ data: { id: a.id, approve: !a.passport_approved } }))}>{a.passport_approved ? "Withdraw approval" : "Approve passport"}</button>}
        </div>
      </section>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <section className="panel p-4 text-sm">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Model (through OMNI)</h2>
          <p className="mb-2 text-xs text-muted-foreground">OMNI routes work to any model; it starts with your existing agents. Connection status: <span className="text-warning">not connected</span>. Changing the model cancels passport approval until you approve again.</p>
          <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); act(f.model({ data: { id: a.id, ...model } })); }}>
            <select aria-label="Adapter" disabled={!manager} value={model.adapter} onChange={(e) => setModel({ ...model, adapter: e.target.value as typeof model.adapter })} className={input}>{ADAPTERS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select>
            <input aria-label="Provider" disabled={!manager} placeholder="Provider" value={model.model_provider} onChange={(e) => setModel({ ...model, model_provider: e.target.value })} className={input} />
            <input aria-label="Model" disabled={!manager} placeholder="Model name" value={model.model_name} onChange={(e) => setModel({ ...model, model_name: e.target.value })} className={input} />
            {manager && <button className={btn}>Save model</button>}
          </form>
        </section>

        <section className="panel p-4 text-sm">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Guardian scope</h2>
          <p className="mb-1 text-xs text-muted-foreground">Only its own project. Anything not listed is refused.</p>
          <div className="mb-3 flex flex-wrap gap-1">{caps.map((c) => <span key={c} className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{CAPABILITIES.find((x) => x.id === c)?.label}</span>)}</div>
          <p className="text-xs text-muted-foreground">Needs your approval: {CAPABILITIES.filter((c) => OWNER_ONLY.includes(c.id)).map((c) => c.label.toLowerCase()).join(", ")}.</p>
        </section>
      </div>

      <section className="panel mb-6 p-4 text-sm">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">JAX enrollment (separate, consent-based)</h2>
        <p className="mb-2 text-xs text-muted-foreground">Off unless you turn it on with a written purpose. Vault data, code, credentials and personal data are never included. JAX connection: <span className="text-warning">not connected</span>, so nothing is sent.</p>
        {a.jax_enrolled ? (
          <div className="flex flex-wrap items-center gap-2 text-xs"><span className="text-success">Enrolled</span> · Purpose: {a.jax_consent_purpose} {owner && <button className={btn} onClick={() => act(f.jax({ data: { id: a.id, enroll: false, purpose: "" } }))}>Withdraw consent</button>}</div>
        ) : owner ? (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); act(f.jax({ data: { id: a.id, enroll: true, purpose } })); }}>
            <input required minLength={10} aria-label="Consent purpose" placeholder="Purpose, e.g. aggregated usage metrics for pricing" value={purpose} onChange={(e) => setPurpose(e.target.value)} className={`${input} flex-1`} />
            <button className={btn}>Enroll with consent</button>
          </form>
        ) : <p className="text-xs text-muted-foreground">Not enrolled.</p>}
      </section>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Feedback history ({d.reports.length})</h2>
      <ul className="mb-6 space-y-2">
        {d.reports.length === 0 && <li className="panel p-4 text-sm text-muted-foreground">This agent hasn't sent any reports.</li>}
        {d.reports.map((r) => (
          <li key={r.id} className="panel flex flex-col gap-2 p-3 text-sm md:flex-row md:items-center md:justify-between">
            <div><span className="font-mono text-xs text-electric">P{r.priority} · {r.severity} · {r.status}</span><div>{r.title}</div></div>
            {manager && (
              <div className="flex gap-2">
                {(["code", "test"] as const).map((k) => <button key={k} className={btn} onClick={() => act(f.job({ data: { projectId: a.project_id, reportId: r.id, kind: k, instructions: r.title, agentId: a.id } }))}>Request OMNI {k} job</button>)}
              </div>
            )}
          </li>
        ))}
      </ul>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">OMNI jobs for this project</h2>
      <ul className="panel mb-6 space-y-1 p-4 text-xs">
        {d.jobs.length === 0 && <li className="text-muted-foreground">None.</li>}
        {d.jobs.map((j) => <li key={j.id}><span className="font-mono">{j.kind}</span> · {j.instructions} · <span className="text-warning">{j.sent_at ? j.status : "queued here — not sent (OMNI not connected)"}</span> · Guardian: {j.guardian_verdict} · merge/deploy: owner approval</li>)}
      </ul>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Audit trail</h2>
      <ul className="panel space-y-1 p-4 font-mono text-xs">{d.trail.length === 0 && <li className="text-muted-foreground">No entries.</li>}{d.trail.map((x) => <li key={x.id}>{new Date(x.at).toLocaleString()} · {x.action} · {x.outcome}</li>)}</ul>
    </>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return <div><div className="text-xs uppercase tracking-wider text-muted-foreground">{k}</div><div>{v}</div></div>;
}

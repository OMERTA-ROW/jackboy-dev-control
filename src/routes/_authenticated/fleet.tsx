import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { PageHeader, GuidanceTip } from "@/components/AppShell";
import { AUTONOMY, CAPABILITIES, OWNER_ONLY, autonomousCapabilities, type Autonomy, type AgentCategory } from "@/lib/guardian";
import { addAgent, emergencyPause, getFleet, simulateGuardian, updateAgent } from "@/lib/fleet.functions";

export const Route = createFileRoute("/_authenticated/fleet")({
  head: () => ({
    meta: [
      { title: "Agent Fleet — Jackboy" },
      { name: "description", content: "Owner dashboard for AngelTech and DemonTech agents: capabilities, autonomy, health, activity and emergency pause." },
      { property: "og:title", content: "Agent Fleet — Jackboy" },
      { property: "og:description", content: "Give every agent its wings — governed by Guardian." },
    ],
  }),
  component: Fleet,
});

type Data = Awaited<ReturnType<typeof getFleet>>;
const btn = "rounded-md border border-border px-2.5 py-1 text-xs hover:border-electric disabled:opacity-40";
const input = "rounded-md border border-input bg-background px-3 py-2 text-sm";

function Fleet() {
  const load = useServerFn(getFleet);
  const f = { add: useServerFn(addAgent), upd: useServerFn(updateAgent), pause: useServerFn(emergencyPause), sim: useServerFn(simulateGuardian) };
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ projectId: "", name: "", category: "angeltech" as AgentCategory, specialty: "" });
  const [sim, setSim] = useState({ agentId: "", action: "propose", targetProjectId: "" });
  const [verdict, setVerdict] = useState<{ allow: boolean; needsOwner: boolean; reason: string } | null>(null);

  const refresh = useCallback(() => load().then(setD).catch((e) => setErr((e as Error).message)), [load]);
  useEffect(() => { refresh(); }, [refresh]);
  const act = async (p: Promise<unknown>) => { setErr(null); try { await p; await refresh(); } catch (e) { setErr((e as Error).message); } };

  if (!d) return <><PageHeader title="Agent Fleet" subtitle="Loading…" />{err && <p className="text-sm text-destructive">{err}</p>}</>;
  const owner = d.role === "owner";
  const manager = d.role !== "member";
  const paused = Boolean(d.policy?.paused);
  const pname = (id: string) => d.projects.find((p) => p.id === id)?.name ?? "—";
  const count = (c: AgentCategory) => d.agents.filter((a) => a.category === c).length;

  return (
    <>
      <PageHeader title="Agent Fleet" subtitle="Give every agent its wings: each project's agents have their own specialty and freedom to explore. Guardian checks every action, and anything not explicitly allowed is refused." />
      {err && <p role="alert" className="mb-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive">{err}</p>}

      <section className={`panel mb-6 grid gap-3 p-4 text-sm md:grid-cols-4 ${paused ? "border-destructive/60" : ""}`}>
        <Stat label="AngelTech" value={count("angeltech")} />
        <Stat label="DemonTech" value={count("demontech")} />
        <Stat label="Verified installed" value={d.agents.filter((a) => a.installed_verified).length} />
        <div className="flex flex-col justify-center gap-1">
          <span className={paused ? "font-semibold text-destructive" : "font-semibold text-success"}>{paused ? "EMERGENCY PAUSE ON" : "Running"}</span>
          {owner && <button className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground" onClick={() => act(f.pause({ data: { paused: !paused } }))}>{paused ? "Lift emergency pause" : "Emergency pause"}</button>}
        </div>
      </section>

      <section className="panel mb-6 p-4 text-xs">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Guardian · connections</h2>
        <div className="flex flex-wrap gap-3">
          {Object.entries(d.integrations).map(([k, v]) => <span key={k} className={v ? "text-success" : "text-muted-foreground"}>{k}: {v ? "verified" : "not connected — refused"}</span>)}
        </div>
        <p className="mt-2 text-muted-foreground">Guardian lets agents act only inside their own project. Any action that needs a missing connection is refused. Always owner-approved: {CAPABILITIES.filter((c) => OWNER_ONLY.includes(c.id)).map((c) => c.label.toLowerCase()).join(", ")}.</p>
      </section>

      {manager && (
        <form className="panel mb-6 grid gap-2 p-4 md:grid-cols-5" onSubmit={(e) => { e.preventDefault(); act(f.add({ data: form })).then(() => setForm({ ...form, name: "", specialty: "" })); }}>
          <select required aria-label="Project" value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })} className={input}><option value="">Project…</option>{d.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <input required aria-label="Agent name" placeholder="Agent name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} />
          <select aria-label="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as AgentCategory })} className={input}><option value="angeltech">AngelTech</option><option value="demontech" disabled={!owner}>DemonTech{owner ? "" : " (owner only)"}</option></select>
          <input aria-label="Specialty" placeholder="Specialty, e.g. accessibility" value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} className={input} />
          <button className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground" disabled={!d.projects.length}>Register agent</button>
          {!d.projects.length && <p className="text-xs text-muted-foreground md:col-span-5">Add a project in the Agent Hub first.</p>}
        </form>
      )}
      <GuidanceTip>New agents start at "Observe" and as "not installed". Only Jackboy can mark an agent installed, once that agent has checked in with its own key.</GuidanceTip>

      <div className="mb-6 grid gap-3 lg:grid-cols-2">
        {d.agents.length === 0 && <p className="panel p-4 text-sm text-muted-foreground">No agents registered.</p>}
        {d.agents.map((a) => {
          const caps = autonomousCapabilities(a.category as AgentCategory, a.autonomy as Autonomy);
          return (
            <article key={a.id} className="panel p-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{a.name} <span className={`ml-1 text-xs ${a.category === "demontech" ? "text-destructive" : "text-electric"}`}>{a.category === "demontech" ? "DemonTech" : "AngelTech"}</span></span>
                <span className="text-xs text-muted-foreground">{a.paused ? "paused" : a.installed_verified ? `installed · ${a.health}` : "not installed"}</span>
              </div>
              <p className="text-xs text-muted-foreground">{pname(a.project_id)} · {a.specialty || "no specialty"} · {a.last_seen_at ? `seen ${new Date(a.last_seen_at).toLocaleString()}` : "never seen"}</p>
              <div className="mt-2 flex flex-wrap gap-1">{caps.map((c) => <span key={c} className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{CAPABILITIES.find((x) => x.id === c)?.label}</span>)}</div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <div role="radiogroup" aria-label={`Autonomy for ${a.name}`} className="inline-flex rounded-md border border-border p-0.5 text-xs">
                  {AUTONOMY.map((t) => (
                    <button key={t.id} role="radio" aria-checked={a.autonomy === t.id} title={t.detail} disabled={!owner && t.id !== "observe"}
                      onClick={() => act(f.upd({ data: { id: a.id, autonomy: t.id } }))}
                      className={`rounded px-2 py-1 disabled:opacity-40 ${a.autonomy === t.id ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>{t.label}</button>
                  ))}
                </div>
                {manager && <button className={btn} disabled={!a.paused && false} onClick={() => act(f.upd({ data: { id: a.id, paused: !a.paused } }))}>{a.paused ? "Unpause" : "Pause"}</button>}
              </div>
            </article>
          );
        })}
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Ask Guardian (test, logged)</h2>
      <form className="panel mb-6 grid gap-2 p-4 text-sm md:grid-cols-4" onSubmit={(e) => { e.preventDefault(); setErr(null); f.sim({ data: sim }).then((v) => { setVerdict(v); refresh(); }).catch((x) => setErr(x.message)); }}>
        <select required aria-label="Agent" value={sim.agentId} onChange={(e) => setSim({ ...sim, agentId: e.target.value })} className={input}><option value="">Agent…</option>{d.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        <select aria-label="Action" value={sim.action} onChange={(e) => setSim({ ...sim, action: e.target.value })} className={input}>{CAPABILITIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
        <select required aria-label="Target project" value={sim.targetProjectId} onChange={(e) => setSim({ ...sim, targetProjectId: e.target.value })} className={input}><option value="">On project…</option>{d.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <button className={btn}>Check</button>
        {verdict && <p aria-live="polite" className="md:col-span-4"><span className={verdict.allow ? "text-success" : "text-destructive"}>{verdict.allow ? "Allowed" : verdict.needsOwner ? "Needs owner approval" : "Refused"}</span> — {verdict.reason}</p>}
      </form>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Recent activity</h2>
      <ul className="panel space-y-1 p-4 font-mono text-xs">{d.activity.length === 0 && <li className="text-muted-foreground">No activity yet.</li>}{d.activity.map((x) => <li key={x.id}>{new Date(x.at).toLocaleString()} · {x.action} · {x.outcome}</li>)}</ul>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div><div className="font-display text-2xl font-bold text-silver">{value}</div><div className="text-xs text-muted-foreground">{label}</div></div>;
}

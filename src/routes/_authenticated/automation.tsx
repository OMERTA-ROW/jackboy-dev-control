import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { PageHeader, GuidanceTip } from "@/components/AppShell";
import { HIGH_RISK, LEARNING_KINDS, TIERS, type LearningKind } from "@/lib/automation-policy";
import { draftPlaybook, evaluateChange, getAutomation, recordLearning, setPolicy, verifyPlaybook } from "@/lib/automation.functions";

export const Route = createFileRoute("/_authenticated/automation")({
  head: () => ({
    meta: [
      { title: "Automation Policy — Jackboy" },
      { name: "description", content: "Owner-controlled learning, playbooks and approval tiers for the Jackboy → OMNI → Guardian workflow." },
      { property: "og:title", content: "Automation Policy — Jackboy" },
      { property: "og:description", content: "Pause, revoke and audit every automated decision." },
    ],
  }),
  component: Automation,
});

type Data = Awaited<ReturnType<typeof getAutomation>>;
type Eval = Awaited<ReturnType<typeof evaluateChange>>;
const btn = "rounded-md border border-border px-3 py-1.5 text-xs hover:border-electric disabled:opacity-40";
const input = "rounded-md border border-input bg-background px-3 py-2 text-sm";

function Automation() {
  const load = useServerFn(getAutomation);
  const f = { set: useServerFn(setPolicy), rec: useServerFn(recordLearning), draft: useServerFn(draftPlaybook), verify: useServerFn(verifyPlaybook), evaluate: useServerFn(evaluateChange) };
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ev, setEv] = useState({ projectId: "", kind: "diagnostic" as LearningKind, summary: "" });
  const [pb, setPb] = useState({ title: "", trigger: "", steps: "" });
  const [chg, setChg] = useState({ action: "merge" as "merge" | "deploy_staging" | "deploy_production", categories: "", filesChanged: 1, linesChanged: 10, testsPassed: false, branchProtected: false, rollbackPlan: false, guardianVerdict: "none" as "pass" | "fail" | "none" });
  const [result, setResult] = useState<Eval | null>(null);

  const refresh = useCallback(() => load().then(setD).catch((e) => setErr((e as Error).message)), [load]);
  useEffect(() => { refresh(); }, [refresh]);
  const act = async (p: Promise<unknown>) => { setErr(null); try { await p; await refresh(); } catch (e) { setErr((e as Error).message); } };

  if (!d?.policy) return <><PageHeader title="Automation Policy" subtitle="Loading…" />{err && <p className="text-sm text-destructive">{err}</p>}</>;
  const p = d.policy;
  const owner = d.role === "owner";
  const save = (patch: Partial<{ tier: number; paused: boolean; maxFiles: number; maxLines: number }>) =>
    act(f.set({ data: { tier: p.tier, paused: p.paused, maxFiles: p.max_files, maxLines: p.max_lines, ...patch } }));

  return (
    <>
      <PageHeader title="Automation Policy" subtitle="Jackboy learns from your projects' history and owner-checked playbooks only. It never changes itself or trains on your private code." />
      {err && <p role="alert" className="mb-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive">{err}</p>}

      <section className={`panel mb-6 flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between ${p.paused ? "border-destructive/60" : ""}`}>
        <div className="text-sm">
          <div className="font-semibold">{p.paused ? <span className="text-destructive">Automation PAUSED</span> : <span className="text-success">Automation active</span>} · Tier {p.tier}: {TIERS[p.tier]?.name}</div>
          <div className="text-xs text-muted-foreground">OMNI: {d.omniVerified ? "verified" : "not connected — nothing is sent"} · Guardian: {p.guardian_verified ? "verified" : "not connected — can't approve anything"}</div>
        </div>
        {owner && (
          <div className="flex gap-2">
            <button className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground" onClick={() => save({ paused: !p.paused })}>{p.paused ? "Resume" : "Pause all automation"}</button>
            <button className={btn} disabled={p.tier === 0} onClick={() => save({ tier: 0 })}>Revoke to tier 0</button>
          </div>
        )}
      </section>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Approval tiers</h2>
      <div className="mb-2 grid gap-3 md:grid-cols-3">
        {TIERS.map((t) => (
          <button key={t.tier} disabled={!owner} onClick={() => save({ tier: t.tier })} aria-pressed={p.tier === t.tier}
            className={`panel p-4 text-left text-sm ${p.tier === t.tier ? "glow-electric border-electric" : ""}`}>
            <div className="font-medium">Tier {t.tier} · {t.name}</div><div className="mt-1 text-xs text-muted-foreground">{t.detail}</div>
          </button>
        ))}
      </div>
      <p className="mb-2 text-xs text-muted-foreground">Guardian can only approve when it is connected and checked, tests have passed, the branch is protected, a rollback plan exists, and the change is within {p.max_files} files / {p.max_lines} lines. Always owner: {HIGH_RISK.join(", ")} and any production deploy.</p>
      {owner && (
        <div className="mb-6 flex gap-3 text-xs">
          <label>Max files <input type="number" min={1} max={20} defaultValue={p.max_files} onBlur={(e) => save({ maxFiles: Number(e.target.value) })} className={`${input} w-20`} /></label>
          <label>Max lines <input type="number" min={1} max={500} defaultValue={p.max_lines} onBlur={(e) => save({ maxLines: Number(e.target.value) })} className={`${input} w-24`} /></label>
        </div>
      )}

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Test a change against the policy</h2>
      <form className="panel mb-6 grid gap-2 p-4 text-xs md:grid-cols-4" onSubmit={(e) => { e.preventDefault(); setErr(null); f.evaluate({ data: { ...chg, categories: chg.categories.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) } }).then((r) => { setResult(r); refresh(); }).catch((x) => setErr(x.message)); }}>
        <select aria-label="Action" value={chg.action} onChange={(e) => setChg({ ...chg, action: e.target.value as typeof chg.action })} className={input}><option value="merge">Merge</option><option value="deploy_staging">Deploy to staging</option><option value="deploy_production">Deploy to production</option></select>
        <input aria-label="Areas" placeholder="Areas, e.g. docs, auth" value={chg.categories} onChange={(e) => setChg({ ...chg, categories: e.target.value })} className={input} />
        <input aria-label="Files changed" type="number" value={chg.filesChanged} onChange={(e) => setChg({ ...chg, filesChanged: Number(e.target.value) })} className={input} />
        <input aria-label="Lines changed" type="number" value={chg.linesChanged} onChange={(e) => setChg({ ...chg, linesChanged: Number(e.target.value) })} className={input} />
        {(["testsPassed", "branchProtected", "rollbackPlan"] as const).map((k) => (
          <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={chg[k]} onChange={(e) => setChg({ ...chg, [k]: e.target.checked })} />{{ testsPassed: "Tests passed", branchProtected: "Branch protected", rollbackPlan: "Rollback plan" }[k]}</label>
        ))}
        <select aria-label="Guardian verdict" value={chg.guardianVerdict} onChange={(e) => setChg({ ...chg, guardianVerdict: e.target.value as typeof chg.guardianVerdict })} className={input}><option value="none">No Guardian verdict</option><option value="pass">Guardian pass</option><option value="fail">Guardian fail</option></select>
        <button className="rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground md:col-span-4">Check routing (logged)</button>
        {result && (
          <div className="md:col-span-4" aria-live="polite">
            <div className="font-semibold">Goes to: <span className={result.decision.route === "guardian" ? "text-success" : result.decision.route === "blocked" ? "text-destructive" : "text-electric"}>{result.decision.route === "guardian" ? "Guardian" : result.decision.route === "blocked" ? "Blocked" : "Owner"}</span></div>
            <ul className="list-disc pl-5 text-muted-foreground">{result.decision.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            <div className="text-muted-foreground">Sending to OMNI: {result.dispatch.reason}</div>
          </div>
        )}
      </form>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <section className="panel min-w-0 p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Project history</h2>
          <form className="mb-3 grid gap-2" onSubmit={(e) => { e.preventDefault(); act(f.rec({ data: { ...ev, outcome: "recorded" } })).then(() => setEv({ ...ev, summary: "" })); }}>
            <div className="flex flex-wrap gap-2">
              <select required aria-label="Project" value={ev.projectId} onChange={(e) => setEv({ ...ev, projectId: e.target.value })} className={`${input} min-w-0 flex-1`}><option value="">Project…</option>{d.projects.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
              <select aria-label="Kind" value={ev.kind} onChange={(e) => setEv({ ...ev, kind: e.target.value as LearningKind })} className={input}>{LEARNING_KINDS.map((k) => <option key={k} value={k}>{k.replace("_", " ")}</option>)}</select>
            </div>
            <input required aria-label="Summary" placeholder="What happened" value={ev.summary} onChange={(e) => setEv({ ...ev, summary: e.target.value })} className={input} />
            <button className={btn} disabled={!d.projects.length}>Record</button>
            {!d.projects.length && <p className="text-xs text-muted-foreground">Add a project in the Agent Hub first.</p>}
          </form>
          <ul className="space-y-1 text-xs">{d.events.length === 0 && <li className="text-muted-foreground">Nothing recorded yet.</li>}{d.events.map((x) => <li key={x.id}><span className="font-mono text-electric">{x.kind}</span> {x.summary} <span className="text-muted-foreground">· {new Date(x.created_at).toLocaleString()}</span></li>)}</ul>
        </section>

        <section className="panel p-4">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Playbooks</h2>
          <GuidanceTip>Jackboy only reuses playbooks the owner has checked.</GuidanceTip>
          <form className="mb-3 grid gap-2" onSubmit={(e) => { e.preventDefault(); act(f.draft({ data: pb })).then(() => setPb({ title: "", trigger: "", steps: "" })); }}>
            <input required placeholder="Title" aria-label="Playbook title" value={pb.title} onChange={(e) => setPb({ ...pb, title: e.target.value })} className={input} />
            <input required placeholder="When to use (keywords)" aria-label="Trigger" value={pb.trigger} onChange={(e) => setPb({ ...pb, trigger: e.target.value })} className={input} />
            <textarea required placeholder="Steps" aria-label="Steps" value={pb.steps} onChange={(e) => setPb({ ...pb, steps: e.target.value })} className={`${input} min-h-20`} />
            <button className={btn}>Save draft</button>
          </form>
          <ul className="space-y-2 text-xs">{d.playbooks.map((x) => (
            <li key={x.id} className="flex items-center justify-between gap-2 rounded-md bg-muted p-2"><span><span className={x.verified ? "text-success" : "text-muted-foreground"}>{x.verified ? "Checked" : "Draft"}</span> · {x.title}</span>
              {owner && <button className={btn} onClick={() => act(f.verify({ data: { id: x.id, verified: !x.verified } }))}>{x.verified ? "Withdraw" : "Mark checked"}</button>}</li>
          ))}</ul>
        </section>
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Decision log</h2>
      <ul className="panel space-y-1 p-4 font-mono text-xs">{d.decisions.length === 0 && <li className="text-muted-foreground">No decisions yet.</li>}{d.decisions.map((x) => <li key={x.id}>{new Date(x.at).toLocaleString()} · {x.action} · {x.outcome}</li>)}</ul>
    </>
  );
}

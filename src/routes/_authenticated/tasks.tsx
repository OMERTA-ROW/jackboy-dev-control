import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { CheckCircle2, CircleDashed, KeyRound, Loader2, OctagonX, Play, RotateCcw, Square, XCircle } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { btn, field, primaryBtn } from "@/components/ProjectBits";
import { useStepUp } from "@/lib/step-up-client";
import { progress, stepTarget, STEP_TYPE_LABEL, type StepType } from "@/lib/task-mode";
import { advanceTaskFn, approveTaskStepFn, getTask, listTasks, planTaskFn, retryTaskFn, startTaskFn, stopTaskFn } from "@/lib/task-mode.functions";

export const Route = createFileRoute("/_authenticated/tasks")({
  validateSearch: z.object({ id: z.string().uuid().optional() }),
  head: () => ({
    meta: [
      { title: "Task Mode — Jackboy" },
      { name: "description", content: "Give Jackboy a task in plain words; it runs the steps with live progress and stops for your passkey at every checkpoint." },
      { property: "og:title", content: "Task Mode — Jackboy" },
      { property: "og:description", content: "Plain-words tasks with live progress and passkey checkpoints." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Tasks,
});

type Detail = Awaited<ReturnType<typeof getTask>>;
type Summary = Awaited<ReturnType<typeof listTasks>>[number];
const STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: "Draft — review, then Start", tone: "text-electric" }, running: { label: "Running", tone: "text-electric" },
  waiting: { label: "Waiting for your passkey", tone: "text-warning" }, done: { label: "Done", tone: "text-success" },
  failed: { label: "Failed", tone: "text-destructive" }, stopped: { label: "Stopped", tone: "text-muted-foreground" },
};
const STEP_ICON: Record<string, React.ReactNode> = {
  done: <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />, running: <Loader2 className="h-4 w-4 animate-spin text-electric" aria-hidden />,
  waiting: <KeyRound className="h-4 w-4 text-warning" aria-hidden />, failed: <XCircle className="h-4 w-4 text-destructive" aria-hidden />,
  stopped: <OctagonX className="h-4 w-4 text-muted-foreground" aria-hidden />, approved: <CheckCircle2 className="h-4 w-4 text-electric" aria-hidden />,
  pending: <CircleDashed className="h-4 w-4 text-muted-foreground" aria-hidden />,
};

function Tasks() {
  const { id } = Route.useSearch();
  const navigate = Route.useNavigate();
  const list = useServerFn(listTasks), get = useServerFn(getTask), plan = useServerFn(planTaskFn), start = useServerFn(startTaskFn);
  const advance = useServerFn(advanceTaskFn), approve = useServerFn(approveTaskStepFn), stop = useServerFn(stopTaskFn), retry = useServerFn(retryTaskFn);
  const stepUp = useStepUp();
  const [tasks, setTasks] = useState<Summary[]>([]);
  const [d, setD] = useState<Detail | null>(null);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const advancing = useRef(false);

  const refreshList = useCallback(() => list().then(setTasks).catch(() => {}), [list]);
  const load = useCallback(async () => { if (id) setD(await get({ data: { taskId: id } })); else setD(null); }, [get, id]);
  useEffect(() => { void refreshList(); }, [refreshList]);
  useEffect(() => { load().catch((e) => setMsg({ text: (e as Error).message, tone: "error" })); }, [load]);

  // While this page is open, keep a running task moving and the feed fresh. Checkpoints always wait for you.
  const status = d?.task.status;
  useEffect(() => {
    if (!id || (status !== "running" && status !== "waiting")) return;
    const tick = async () => {
      if (status === "running" && !advancing.current) {
        advancing.current = true;
        try { await advance({ data: { taskId: id } }); } catch (e) { setMsg({ text: (e as Error).message, tone: "error" }); } finally { advancing.current = false; }
      }
      await load().catch(() => {});
    };
    void tick();
    const t = window.setInterval(() => void tick(), 3000);
    return () => window.clearInterval(t);
  }, [id, status, advance, load]);
  useEffect(() => { if (status) void refreshList(); }, [status, refreshList]);

  const act = async (name: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(name); setMsg(null);
    try { await fn(); if (ok) setMsg({ text: ok, tone: "ok" }); } catch (e) { setMsg({ text: (e as Error).message, tone: "error" }); }
    finally { setBusy(null); await load().catch(() => {}); void refreshList(); }
  };
  const onPlan = () => act("plan", async () => {
    const r = await plan({ data: { goal } });
    setGoal("");
    await navigate({ search: { id: r.taskId } });
  }, "Steps drafted. Review them, then press Start.");
  const waitingStep = d?.steps.find((s) => s.status === "waiting");
  const onApprove = () => waitingStep && act("approve", () => stepUp("task_step", stepTarget(waitingStep.id, waitingStep.fingerprint), {
    applyingText: `Approving step ${waitingStep.position}…`,
    apply: (grantId) => approve({ data: { stepId: waitingStep.id, grantId } }),
    doneText: () => `Step ${waitingStep.position} approved. Continuing.`,
  }));

  const p = d ? progress(d.steps) : null;
  const st = d ? STATUS[d.task.status] ?? STATUS["draft"]! : null;
  return (
    <div>
      <PageHeader title="Task Mode" subtitle="Tell Jackboy what to do in plain words. It drafts the steps, runs them with live progress, and stops for your passkey before anything that changes your projects." />

      <section className="panel p-4" aria-labelledby="new-task">
        <h2 id="new-task" className="font-semibold">New task</h2>
        <p className="text-xs text-muted-foreground">For now Task Mode works inside Jackboy only (your projects and repos), not on outside websites. Paying, publishing, deleting, sending and credential changes are never automatic.</p>
        <label htmlFor="goal" className="sr-only">Task</label>
        <textarea id="goal" className={`${field} mt-2 min-h-20`} placeholder="e.g. Check Hercules Driver OS: site status, repo connection, run an inspection, and save what you found to memory." value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={2000} />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" className={primaryBtn} disabled={goal.trim().length < 3 || !!busy} onClick={onPlan}>{busy === "plan" ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Drafting steps…</> : "Draft steps"}</button>
          <Link to="/settings" hash="task-skip" className="text-xs text-electric underline">Steps that can skip approval</Link>
        </div>
      </section>

      {msg && <p role="status" className={`mt-3 text-sm ${msg.tone === "error" ? "text-destructive" : "text-success"}`}>{msg.text}</p>}

      <div className="mt-4 grid gap-4 lg:grid-cols-[18rem_1fr]">
        <section className="panel p-3" aria-labelledby="task-list">
          <h2 id="task-list" className="px-1 text-sm font-semibold">Tasks</h2>
          {!tasks.length && <p className="px-1 py-2 text-sm text-muted-foreground">No tasks yet.</p>}
          <ul className="mt-1 space-y-1">
            {tasks.map((t) => (
              <li key={t.id}>
                <Link to="/tasks" search={{ id: t.id }} className={`block rounded-md px-2 py-1.5 text-sm hover:bg-secondary ${t.id === id ? "bg-secondary" : ""}`}>
                  <span className="line-clamp-2">{t.goal}</span>
                  <span className={`text-xs ${STATUS[t.status]?.tone ?? ""}`}>{STATUS[t.status]?.label ?? t.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        {d && st && p ? (
          <section className="panel p-4" aria-labelledby="task-detail">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h2 id="task-detail" className="font-semibold">{d.task.goal}</h2>
              <span className={`text-xs font-semibold uppercase ${st.tone}`} aria-live="polite">{st.label}</span>
            </div>
            {d.task.stop_reason && <p className="mt-1 text-sm text-muted-foreground">{d.task.stop_reason}</p>}
            <div className="mt-3" aria-label={`${p.done} of ${p.total} steps done`}>
              <div className="h-2 overflow-hidden rounded bg-muted"><div className={`h-full transition-all ${d.task.status === "failed" ? "bg-destructive" : d.task.status === "done" ? "bg-success" : "bg-electric"}`} style={{ width: `${p.pct}%` }} /></div>
              <p className="mt-1 text-xs text-muted-foreground">{p.done} of {p.total} steps done</p>
            </div>

            <ol className="mt-3 space-y-2" aria-label="Steps">
              {d.steps.map((s) => (
                <li key={s.id} className={`rounded-md border p-2 ${s.status === "waiting" ? "border-warning" : "border-border"}`}>
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5">{STEP_ICON[s.status] ?? STEP_ICON["pending"]}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm"><span className="font-medium">{s.position}. {s.why || s.tool}</span></p>
                      <p className="text-xs text-muted-foreground">{STEP_TYPE_LABEL[s.step_type as StepType] ?? s.step_type} · {s.tool}{s.step_type !== "read" ? " · needs your passkey unless you allowed it" : ""}</p>
                      <details className="mt-1"><summary className="cursor-pointer text-xs text-electric">Details</summary>
                        <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap break-all">{s.args}</pre>
                        {s.result && <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap break-all">{s.result}</pre>}
                      </details>
                      {s.error && <p className="mt-1 text-xs text-destructive">{s.error}</p>}
                    </div>
                  </div>
                </li>
              ))}
            </ol>

            {waitingStep && d.task.status === "waiting" && (
              <div className="mt-3 rounded-md border border-warning p-3">
                <p className="text-sm font-medium">Checkpoint: step {waitingStep.position}</p>
                <p className="text-xs text-muted-foreground">Jackboy will run exactly what's shown in this step's details. Your passkey approves this one step only.</p>
                <button type="button" className={`${primaryBtn} mt-2`} disabled={!!busy} onClick={onApprove}><KeyRound className="h-4 w-4" aria-hidden />{busy === "approve" ? "Approving…" : "Approve with passkey"}</button>
              </div>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              {d.task.status === "draft" && <button type="button" className={primaryBtn} disabled={!!busy} onClick={() => act("start", () => start({ data: { taskId: d.task.id } }))}><Play className="h-4 w-4" aria-hidden />{busy === "start" ? "Starting…" : "Start"}</button>}
              {["draft", "running", "waiting"].includes(d.task.status) && <button type="button" className={btn} disabled={!!busy} onClick={() => act("stop", () => stop({ data: { taskId: d.task.id } }), "Stopped.")}><Square className="h-4 w-4" aria-hidden />{d.task.status === "draft" ? "Discard" : "Stop"}</button>}
              {["failed", "stopped"].includes(d.task.status) && d.task.started_at && <button type="button" className={btn} disabled={!!busy} onClick={() => act("retry", () => retry({ data: { taskId: d.task.id } }))}><RotateCcw className="h-4 w-4" aria-hidden />Retry</button>}
            </div>

            <h3 className="mt-4 text-sm font-semibold">Live activity</h3>
            <ol className="mt-1 max-h-72 space-y-1 overflow-auto text-xs" aria-live="polite">
              {d.events.map((e) => (
                <li key={e.id} className="flex gap-2"><time className="shrink-0 text-muted-foreground" dateTime={e.created_at}>{new Date(e.created_at).toLocaleTimeString()}</time><span className={/failed/.test(e.kind) ? "text-destructive" : /checkpoint/.test(e.kind) ? "text-warning" : /finished|approved/.test(e.kind) ? "text-success" : ""}>{e.message}</span></li>
              ))}
            </ol>
          </section>
        ) : (
          <section className="panel p-4 text-sm text-muted-foreground">Pick a task or draft a new one.</section>
        )}
      </div>
    </div>
  );
}

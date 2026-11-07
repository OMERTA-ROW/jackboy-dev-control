import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, CircleSlash, Loader2, RotateCcw, Square, XCircle } from "lucide-react";
import { foundryInspect, foundryProgress, foundryStopInspect } from "@/lib/foundry.functions";
import { feedFromEvents, isActive, runOutcome, runTrail, scanFraction, stallInfo, type FeedLine, type InspectOutcome, type RunEvent, type RunPhase } from "@/lib/activity-feed";
import { elapsed } from "@/lib/connect-select";

export type InspectRun = {
  runId: string; projectId: string; phase: RunPhase; startedAt: number; endedAt?: number;
  lastSeenAt: number; stopAskedAt?: number; trail: RunEvent[]; head: FeedLine[]; tail: FeedLine[]; result?: string;
};

const STOP_WAIT_MS = 30_000; // after this, stop waiting in the browser even if the server hasn't confirmed yet
const newId = () => crypto.randomUUID();

/** Live inspection runs keyed by any caller key (usually the project row). Polls real Foundry events, detects stalls, supports Stop and Retry. */
export function useInspectRuns(onFinished?: () => void) {
  const inspect = useServerFn(foundryInspect), progress = useServerFn(foundryProgress), stopFn = useServerFn(foundryStopInspect);
  const [runs, setRuns] = useState<Record<string, InspectRun>>({});
  const ref = useRef(runs);
  ref.current = runs;
  const [, tick] = useState(0);
  const active = Object.values(runs).some((r) => isActive(r.phase));

  const pull = useCallback(async (keys: string[]) => {
    const list = keys.map((k) => [k, ref.current[k]] as const).filter((x): x is readonly [string, InspectRun] => !!x[1]);
    if (!list.length) return;
    const ids = [...new Set(list.map(([, r]) => r.projectId))];
    const since = new Date(Math.min(...list.map(([, r]) => r.startedAt)) - 10 * 60_000).toISOString(); // generous margin for clock differences; runs are matched by id
    const events = (await progress({ data: { projectIds: ids, since } })) as RunEvent[];
    setRuns((cur) => {
      const next = { ...cur };
      for (const [k] of list) {
        const r = cur[k];
        if (!r) continue;
        const trail = runTrail(events.filter((e) => e.project_id === r.projectId), r.runId);
        if (trail.length > r.trail.length) next[k] = { ...r, trail, lastSeenAt: Date.now() };
      }
      return next;
    });
  }, [progress]);

  const finish = useCallback((key: string, runId: string, out: { phase: RunPhase; text: string }) => {
    const now = Date.now();
    const tone = out.phase === "done" || out.phase === "nothing" ? "ok" : out.phase === "failed" ? "error" : "warn";
    const label = out.phase === "nothing" ? "Finished — nothing to do" : out.phase === "done" ? "Finished" : out.phase === "stopped" ? "Stopped" : out.phase === "blocked" ? "Blocked" : "Failed";
    setRuns((cur) => {
      const r = cur[key];
      if (!r || r.runId !== runId || !isActive(r.phase)) return cur; // a retry replaced this run, or it already ended
      return { ...cur, [key]: { ...r, phase: out.phase, endedAt: now, result: out.text, tail: [{ id: `end-${runId}`, at: now, text: `${label}: ${out.text}`, tone }] } };
    });
    void pull([key]).catch(() => {});
    onFinished?.();
  }, [pull, onFinished]);

  const queue = useCallback((key: string, projectId: string) => {
    const now = Date.now();
    setRuns((cur) => ({ ...cur, [key]: { runId: newId(), projectId, phase: "queued", startedAt: now, lastSeenAt: now, trail: [], head: [{ id: "queued", at: now, text: "Queued — waiting for a free slot", tone: "info" }], tail: [] } }));
  }, []);

  const start = useCallback(async (key: string, projectId: string) => {
    const runId = newId(), now = Date.now();
    setRuns((cur) => {
      const prev = cur[key];
      const head = [...(prev?.phase === "queued" ? prev.head : []), { id: `start-${runId}`, at: now, text: "Started — opening the repository", tone: "info" as const }];
      return { ...cur, [key]: { runId, projectId, phase: "running", startedAt: now, lastSeenAt: now, trail: [], head, tail: [] } };
    });
    try {
      const v = await inspect({ data: { projectId, runId } });
      finish(key, runId, runOutcome(v as InspectOutcome));
    } catch (e) {
      finish(key, runId, { phase: "failed", text: (e as Error).message || "The request did not complete." });
    }
  }, [inspect, finish]);

  const stop = useCallback(async (key: string) => {
    const r = ref.current[key];
    if (!r || !isActive(r.phase)) return;
    if (r.phase === "queued") { finish(key, r.runId, { phase: "stopped", text: "Removed from the queue before it started." }); return; }
    setRuns((cur) => (cur[key]?.runId === r.runId ? { ...cur, [key]: { ...cur[key]!, phase: "stopping", stopAskedAt: Date.now() } } : cur));
    try { await stopFn({ data: { projectId: r.projectId, runId: r.runId } }); void pull([key]).catch(() => {}); }
    catch (e) {
      setRuns((cur) => (cur[key]?.runId === r.runId ? { ...cur, [key]: { ...cur[key]!, phase: "running", stopAskedAt: undefined, head: [...cur[key]!.head, { id: `stopfail-${Date.now()}`, at: Date.now(), text: `Could not send Stop: ${(e as Error).message}`, tone: "error" }] } } : cur));
    }
  }, [stopFn, pull, finish]);

  const retry = useCallback(async (key: string) => {
    const r = ref.current[key];
    if (!r) return;
    if (isActive(r.phase)) await stop(key);
    await start(key, r.projectId);
  }, [stop, start]);

  // While anything runs: tick the clock every second, read real events every 2 seconds, and end Stop waits that the server never confirmed.
  useEffect(() => {
    if (!active) return;
    const clock = window.setInterval(() => {
      tick((n) => n + 1);
      for (const [k, r] of Object.entries(ref.current)) {
        if (r.phase === "stopping" && r.stopAskedAt && Date.now() - r.stopAskedAt > STOP_WAIT_MS)
          finish(k, r.runId, { phase: "stopped", text: "Stopped watching. The server was told to stop at its next safe point; nothing merges or deploys on its own." });
      }
    }, 1000);
    const poll = window.setInterval(() => {
      const keys = Object.entries(ref.current).filter(([, r]) => r.phase === "running" || r.phase === "stopping").map(([k]) => k);
      if (keys.length) void pull(keys).catch(() => {});
    }, 2000);
    return () => { window.clearInterval(clock); window.clearInterval(poll); };
  }, [active, pull, finish]);

  return { runs, active, queue, start, stop, retry };
}

const fmtTime = (ms: number) => (ms ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
const TONE: Record<FeedLine["tone"], string> = { info: "text-foreground", ok: "text-success", warn: "text-warning", error: "text-destructive" };
const ctl = "inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50";

/** Live step-by-step feed for one run: status + timer, moving progress bar, timestamped steps, stall warning with Retry / Stop. */
export function ActivityFeed({ run, name, onStop, onRetry }: { run: InspectRun; name?: string; onStop: () => void; onRetry: () => void }) {
  const listRef = useRef<HTMLOListElement>(null);
  const lines = [...run.head, ...feedFromEvents(run.trail), ...run.tail];
  const live = isActive(run.phase);
  const took = elapsed((run.endedAt ?? Date.now()) - run.startedAt);
  const frac = run.phase === "queued" ? null : live ? scanFraction(run.trail) : 1;
  const stall = run.phase === "running" ? stallInfo(run.lastSeenAt, Date.now(), run.trail) : null;
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [lines.length]);

  const status = run.phase === "queued" ? { icon: <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />, text: "Queued", tone: "text-muted-foreground" }
    : run.phase === "running" ? { icon: <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />, text: `Working · ${took}${frac !== null && frac < 1 ? ` · ${Math.round(frac * 100)}%` : ""}`, tone: stall?.stalled ? "text-warning" : "text-electric" }
    : run.phase === "stopping" ? { icon: <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />, text: `Stopping at the next safe point · ${took}`, tone: "text-warning" }
    : run.phase === "done" ? { icon: <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />, text: `Finished in ${took}`, tone: "text-success" }
    : run.phase === "nothing" ? { icon: <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />, text: `Nothing to do · finished in ${took}`, tone: "text-success" }
    : run.phase === "stopped" ? { icon: <CircleSlash className="h-3.5 w-3.5" aria-hidden />, text: `Stopped after ${took}`, tone: "text-warning" }
    : run.phase === "blocked" ? { icon: <AlertTriangle className="h-3.5 w-3.5" aria-hidden />, text: `Blocked after ${took}`, tone: "text-warning" }
    : { icon: <XCircle className="h-3.5 w-3.5" aria-hidden />, text: `Failed after ${took}`, tone: "text-destructive" };
  const barTone = run.phase === "failed" ? "bg-destructive" : run.phase === "blocked" || run.phase === "stopped" || stall?.stalled ? "bg-warning" : run.phase === "done" || run.phase === "nothing" ? "bg-success" : "bg-electric";

  return (
    <div className="mt-2 rounded-md border border-border bg-background/40 p-2" aria-label={`Activity${name ? ` for ${name}` : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`flex items-center gap-1 text-xs font-medium ${status.tone}`}>{status.icon}{status.text}</span>
        <span className="flex gap-1">
          {(run.phase === "running" || run.phase === "queued") && <button type="button" className={ctl} onClick={onStop}><Square className="h-3 w-3" aria-hidden />Stop</button>}
          {(run.phase === "failed" || run.phase === "stopped" || run.phase === "blocked") && <button type="button" className={ctl} onClick={onRetry}><RotateCcw className="h-3 w-3" aria-hidden />Retry</button>}
        </span>
      </div>
      <div className="relative mt-1.5 h-1.5 overflow-hidden rounded bg-muted" role="progressbar" aria-label="Run progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={frac === null ? undefined : Math.round(frac * 100)} aria-valuetext={frac === null ? "In progress" : `${Math.round(frac * 100)}%`}>
        {frac === null ? <div className={`jb-indeterminate absolute inset-y-0 w-1/3 rounded ${barTone}`} /> : <div className={`h-full transition-all duration-500 ${barTone} ${live ? "jb-shimmer" : ""}`} style={{ width: `${Math.max(4, frac * 100)}%` }} />}
      </div>
      {stall?.stalled && (
        <div role="alert" className="mt-2 rounded border border-warning/50 p-2 text-xs text-warning">
          <p>No new progress for {elapsed(stall.quietMs)} (usually under {elapsed(stall.limitMs)}) while: “{lines.at(-1)?.text ?? "starting"}”. It may be stuck.</p>
          <div className="mt-1.5 flex gap-2">
            <button type="button" className={ctl} onClick={onRetry}><RotateCcw className="h-3 w-3" aria-hidden />Retry</button>
            <button type="button" className={ctl} onClick={onStop}><Square className="h-3 w-3" aria-hidden />Stop</button>
          </div>
        </div>
      )}
      <ol ref={listRef} className="mt-2 max-h-40 space-y-0.5 overflow-y-auto text-xs" aria-label="Steps">
        {lines.map((l) => (
          <li key={l.id} className="flex gap-2">
            <time className="shrink-0 tabular-nums text-muted-foreground" dateTime={l.at ? new Date(l.at).toISOString() : undefined}>{fmtTime(l.at)}</time>
            <span className={`min-w-0 break-words ${TONE[l.tone]}`}>{l.text}</span>
          </li>
        ))}
      </ol>
      <p className="sr-only" aria-live="polite">{status.text}. {lines.at(-1)?.text}</p>
    </div>
  );
}

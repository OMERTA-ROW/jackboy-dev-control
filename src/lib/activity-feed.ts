// Pure rules for the live activity feed shown while an inspection / coding loop runs.
// Every line comes from a real server event or a real browser milestone (started, result) — nothing is invented.

export type RunEvent = { project_id: string | null; action: string; to_state: string | null; note: string | null; created_at: string; detail?: unknown };
export type Tone = "info" | "ok" | "warn" | "error";
export type FeedLine = { id: string; at: number; text: string; tone: Tone };
export type RunPhase = "queued" | "running" | "stopping" | "done" | "nothing" | "blocked" | "stopped" | "failed";

const STEP: Record<string, string> = {
  discovered: "Found something to fix", analyzing: "Writing a minimal fix", patch_prepared: "Fix saved on a separate branch",
  testing: "Checking the fix", awaiting_approval: "Ready for your review — waiting for your approval", approved: "Approved, about to run",
  executing: "Running the approved step", verifying: "Verifying the result", completed: "Step completed", blocked: "Blocked", failed: "Failed",
};

const runIdOf = (e: RunEvent): string | null => {
  const d = e.detail as { runId?: unknown } | null | undefined;
  return d && typeof d.runId === "string" ? d.runId : null;
};

/** This run's slice of the project's event trail (oldest → newest): its own tagged events plus untagged task events in between. */
export function runTrail(events: RunEvent[], runId: string): RunEvent[] {
  const first = events.findIndex((e) => runIdOf(e) === runId);
  if (first < 0) return [];
  const out: RunEvent[] = [];
  for (const e of events.slice(first)) {
    const id = runIdOf(e);
    if (id && id !== runId) continue; // another run on the same project
    out.push(e);
    if (id === runId && (e.action === "inspect_finished" || e.action === "inspect_stopped")) break;
  }
  return out;
}

function line(e: RunEvent): { text: string; tone: Tone } {
  const note = e.note ?? "";
  switch (e.action) {
    case "inspect_started": return { text: note || "Reading the repository…", tone: "info" };
    case "scan_progress": return { text: note.replace(/^Checking/, "Inspecting") || "Inspecting files…", tone: "info" };
    case "code_scan": {
      const d = e.detail as { findings?: number } | null | undefined;
      return { text: d?.findings === 0 ? `${note} Found nothing to fix.` : note, tone: d?.findings === 0 ? "ok" : "info" };
    }
    case "discovered": return { text: `Found: ${note}`, tone: "info" };
    case "inspect_queued": return { text: note, tone: "warn" };
    case "inspect_blocked": case "code_scan_failed": return { text: note, tone: "error" };
    case "inspect_stop_requested": return { text: "Stop requested — stopping at the next safe point", tone: "warn" };
    case "inspect_stopped": return { text: note || "Stopped", tone: "warn" };
    case "inspect_finished": return { text: note || "Finished", tone: "ok" };
    case "package_built": return { text: note, tone: "info" };
    case "transition": {
      const s = e.to_state ?? "";
      const tone: Tone = s === "failed" ? "error" : s === "blocked" ? "warn" : s === "awaiting_approval" || s === "completed" ? "ok" : "info";
      return { text: STEP[s] ? `${STEP[s]}${note && (s === "blocked" || s === "failed") ? ` — ${note}` : ""}` : note || s, tone };
    }
    default: return { text: note || e.action.replace(/_/g, " "), tone: "info" };
  }
}

/** Feed lines from the server trail. Repeated "Inspecting file n of N" marks collapse into the latest one so the feed stays readable. */
export function feedFromEvents(trail: RunEvent[]): FeedLine[] {
  const out: FeedLine[] = [];
  trail.forEach((e, i) => {
    const l = { id: `s${i}-${e.action}`, at: Date.parse(e.created_at) || 0, ...line(e) };
    if (e.action === "scan_progress" && out.at(-1)?.id.endsWith("-scan_progress")) out[out.length - 1] = l;
    else out.push(l);
  });
  return out;
}

/** Determinate scan progress (0–1) from the newest progress mark, or null while it can only be shown as "moving". */
export function scanFraction(trail: RunEvent[]): number | null {
  for (let i = trail.length - 1; i >= 0; i--) {
    const e = trail[i]!;
    if (e.action === "code_scan" || e.action === "inspect_finished") return 1;
    if (e.action === "scan_progress") {
      const d = e.detail as { done?: number; total?: number } | null | undefined;
      if (d && typeof d.done === "number" && typeof d.total === "number" && d.total > 0) return Math.min(1, d.done / d.total);
    }
  }
  return null;
}

/** How long a step may stay quiet before we say it looks stalled. AI fix writing and check reading get longer. */
export function stallLimitMs(trail: RunEvent[]): number {
  const e = trail.at(-1);
  if (!e) return 45_000; // opening the repository and listing files
  if (e.action === "transition" && (e.to_state === "analyzing" || e.to_state === "testing" || e.to_state === "executing")) return 120_000;
  if (e.action === "discovered") return 90_000;
  return 45_000;
}

/** Stalled when no new server event has been seen for longer than the step's limit (measured on the browser's own clock). */
export function stallInfo(lastSeenAt: number, now: number, trail: RunEvent[]): { stalled: boolean; quietMs: number; limitMs: number } {
  const quietMs = Math.max(0, now - lastSeenAt), limitMs = stallLimitMs(trail);
  return { stalled: quietMs > limitMs, quietMs, limitMs };
}

export type InspectOutcome = { created?: number; blocked?: string; inspectedFiles?: number; stopped?: boolean };
/** Final phase + plain result for a finished run. "Nothing to do" is its own clear end state. */
export function runOutcome(v: InspectOutcome): { phase: Exclude<RunPhase, "queued" | "running" | "stopping">; text: string } {
  if (v.stopped) return { phase: "stopped", text: "Stopped by you at a safe point. Nothing was merged or deployed." };
  if (v.blocked) return v.blocked.startsWith("Queued") ? { phase: "nothing", text: v.blocked } : { phase: "blocked", text: v.blocked };
  const files = v.inspectedFiles ?? 0;
  if (v.created) return { phase: "done", text: `Inspected ${files} files; prepared ${v.created} change on a separate branch — review it in Code Foundry` };
  return { phase: "nothing", text: `Inspected ${files} files; nothing new to fix. Run ended.` };
}

export const isActive = (p: RunPhase) => p === "queued" || p === "running" || p === "stopping";

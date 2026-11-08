// Pure rules for the Connect page multi-select and the coding-loop status badge.
import { lovableUrl } from "./project-hub";

export type ConnectRow = {
  key: string;                 // "p:<owner_project id>" or "i:<inventory id>"
  name: string;
  projectId: string | null;    // set once connected
  lovableRef: string | null;
  repo: string | null;
  status: "saved_only" | "connected_no_repo" | "repo_linked" | "repo_error";
  devEnabled: boolean;         // owner explicitly activated background work
  detail: string;
};

type P = { id: string; name: string; github_repo: string | null; dev_enabled?: boolean; connect_state?: string | null; connect_error?: string | null; lovable_url?: string | null; repo_sync_status?: string };
type I = { id: string; name: string; lovable_project_ref: string | null };

/** One row per project: connected ones first (truthful repo status), then saved-inventory items not yet connected. */
export function connectRows(projects: P[], inventory: I[]): ConnectRow[] {
  const rows: ConnectRow[] = projects.map((p) => {
    const drift = p.repo_sync_status === "deleted" || p.repo_sync_status === "moved";
    const err = p.connect_state === "error" || Boolean(p.connect_error) || drift;
    const status: ConnectRow["status"] = !p.github_repo ? "connected_no_repo" : err ? "repo_error" : "repo_linked";
    const detail = status === "connected_no_repo" ? "Connected, but no GitHub repo linked — coding is blocked."
      : status === "repo_error" ? drift ? "Repository out of sync — review removal or relink in Settings. No record changed." : `Repo problem: ${p.connect_error ?? "check failed"}` : `Repo ${p.github_repo}`;
    return { key: `p:${p.id}`, name: p.name, projectId: p.id, lovableRef: null, repo: p.github_repo, status, detail, devEnabled: Boolean(p.dev_enabled) };
  });
  const taken = new Set(projects.map((p) => p.name.trim().toLowerCase()));
  for (const i of inventory) {
    if (taken.has(i.name.trim().toLowerCase())) continue;
    rows.push({ key: `i:${i.id}`, name: i.name, projectId: null, lovableRef: i.lovable_project_ref, repo: null, status: "saved_only", detail: "Saved in the list only — not connected yet.", devEnabled: false });
  }
  return byPriority(rows);
}

export function toggle(sel: string[], key: string): string[] {
  return sel.includes(key) ? sel.filter((k) => k !== key) : [...sel, key];
}
export function selectAll(sel: string[], visible: string[]): string[] {
  return [...new Set([...sel, ...visible])];
}

export type LoopEligibility = { ok: true } | { ok: false; reason: string };
/** Coding loop runs only on connected projects with a linked repo; everything else is skipped with the exact fix. */
export function loopEligible(r: ConnectRow): LoopEligibility {
  if (r.status === "saved_only") return { ok: false, reason: "Connect it first" };
  if (r.status === "connected_no_repo") return { ok: false, reason: "Link a GitHub repo Jackboy can write" };
  if (r.status === "repo_error") return { ok: false, reason: r.detail };
  return { ok: true };
}

export function newProjectInput(r: ConnectRow) {
  return { name: r.name, lovable_url: r.lovableRef ? lovableUrl(r.lovableRef) ?? "" : "", site_url: "", github_repo: "", github_branch: "main", description: "", goals: "", notes: "", frequency_hours: 24, active: true };
}

export type AgentState = { label: "Online" | "Working" | "Blocked" | "Offline"; reason: string };
const WORKING = new Set(["discovered", "analyzing", "patch_prepared", "testing", "approved", "executing", "verifying"]);
const STEP_TEXT: Record<string, string> = {
  discovered: "Found something to fix", analyzing: "Writing a minimal fix", patch_prepared: "Fix saved on a branch",
  testing: "Checking the fix", approved: "Approved, about to run", executing: "Running the approved step", verifying: "Verifying the result",
};
/** Truthful status for one project's coding loop, from real Foundry task states only. */
export function agentState(repoOk: boolean, tasks: { state: string; blocked_reason?: string | null; paused?: boolean; title?: string | null }[]): AgentState {
  if (!repoOk) return { label: "Offline", reason: "No writable repo linked" };
  const blocked = tasks.find((t) => t.state === "blocked" || t.paused);
  const working = tasks.find((t) => WORKING.has(t.state));
  if (working) return { label: "Working", reason: `${STEP_TEXT[working.state] ?? working.state.replace("_", " ")}${working.title ? ` — ${working.title}` : ""}` };
  if (blocked) return { label: "Blocked", reason: blocked.blocked_reason ?? (blocked.paused ? "Paused" : "Blocked") };
  return { label: "Online", reason: tasks.some((t) => t.state === "awaiting_approval") ? "Waiting for your approval" : "Idle, ready" };
}

/** Owner-set development order: OMNI, Honeycomb Terminal, Honeycomb Vault, JAX, Nano, Jail Release, then the rest. Lower runs first. */
export function devPriority(name: string): number {
  const n = name.toLowerCase();
  if (/\bomni\b/.test(n)) return 1;
  if (/honeycomb terminal/.test(n)) return 2;
  if (/honeycomb vault/.test(n)) return 3;
  if (/\bjax\b/.test(n)) return 4;
  if (/nano/.test(n)) return 5;
  if (/jail release/.test(n)) return 6;
  return 100;
}
export function byPriority<T extends { name: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => devPriority(a.name) - devPriority(b.name) || a.name.localeCompare(b.name));
}

/** Background work state for one row. "Activate" is offered only when ready; a broken connection needs Reconnect first,
 * and a successful reconnect leaves background work off until the owner activates it again. */
export type BackgroundState = "not_connected" | "needs_reconnect" | "ready" | "active";
export function backgroundState(r: Pick<ConnectRow, "status" | "devEnabled">): BackgroundState {
  if (r.status === "saved_only" || r.status === "connected_no_repo") return "not_connected";
  if (r.status === "repo_error") return "needs_reconnect";
  return r.devEnabled ? "active" : "ready";
}

/** Which bulk buttons apply to the selection. A button with nothing to do is hidden, so it can't show a stale action. */
export function bulkPlan(rows: ConnectRow[]) {
  return {
    connect: rows.filter((r) => r.status === "saved_only" || r.status === "repo_error"),
    needsRepo: rows.filter((r) => r.status === "connected_no_repo"),
    activate: rows.filter((r) => backgroundState(r) === "ready"),
    deactivate: rows.filter((r) => r.devEnabled),
    active: rows.filter((r) => backgroundState(r) === "active"),
    loop: rows.filter((r) => loopEligible(r).ok),
  };
}

/** One coding-loop run on one project, as seen live in the browser. */
export type LoopRun = { phase: "queued" | "running" | "done" | "blocked" | "failed"; startedAt: number; endedAt?: number; step: string; result?: string };
export type LoopEvent = { project_id: string | null; action: string; to_state: string | null; note: string | null; created_at: string };

/** Latest real milestone of a running inspection, from the server's own event trail (oldest → newest). */
export function loopStep(events: LoopEvent[]): string {
  const e = events.at(-1);
  if (!e) return "Opening the repository…";
  if (e.action === "inspect_started") return e.note || "Reading the repository…";
  if (e.action === "code_scan") return e.note || "Scan finished.";
  if (e.action === "transition" && e.to_state) return STEP_TEXT[e.to_state] ? `${STEP_TEXT[e.to_state]}…` : e.to_state === "awaiting_approval" ? "Ready for your review" : e.note || e.to_state;
  return e.note || e.action.replace(/_/g, " ");
}

type InspectResult = { created?: number; blocked?: string; findings?: number; inspectedFiles?: number };
/** Final, plain result line for a finished run. */
export function loopResult(v: InspectResult): { phase: "done" | "blocked"; text: string } {
  if (v.blocked) return { phase: v.blocked.startsWith("Queued") ? "done" : "blocked", text: v.blocked };
  const files = v.inspectedFiles ?? 0;
  if (v.created) return { phase: "done", text: `Inspected ${files} files; prepared ${v.created} change on a branch — review it in Code Foundry` };
  return { phase: "done", text: `Inspected ${files} files; nothing new to fix` };
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Code Foundry pure rules: durable task state machine, approval gating, quotas. Tested in foundry.test.ts.

export const STATES = [
  "discovered", "analyzing", "patch_prepared", "testing", "awaiting_approval", "approved",
  "executing", "verifying", "completed", "failed", "rolled_back", "rejected", "blocked",
] as const;
export type State = (typeof STATES)[number];
export type Risk = "low" | "medium" | "sensitive";
export type ApprovedAction = "open_draft_pr" | "read_checks";

const NEXT: Record<State, State[]> = {
  discovered: ["analyzing", "failed", "rejected"],
  analyzing: ["patch_prepared", "failed", "blocked"],
  patch_prepared: ["testing", "failed", "blocked"],
  testing: ["awaiting_approval", "failed", "blocked"],
  awaiting_approval: ["approved", "rejected"],
  approved: ["executing", "blocked"],
  executing: ["verifying", "failed", "blocked"],
  verifying: ["completed", "failed", "rolled_back"],
  blocked: ["approved", "analyzing", "rejected"],
  failed: ["rolled_back"],
  completed: [], rolled_back: [], rejected: [],
};

export const TERMINAL: State[] = ["completed", "rolled_back", "rejected"];
/** States that belong in the owner's active approval queue. */
export const ACTIVE_APPROVAL: State[] = ["awaiting_approval"];

export function canTransition(from: State, to: State): boolean {
  return NEXT[from]?.includes(to) ?? false;
}

export function assertTransition(from: State, to: State): void {
  if (!canTransition(from, to)) throw new Error(`Illegal transition ${from} → ${to}.`);
}

const SENSITIVE = /(^|\/)(\.env|supabase\/|drizzle\/|src\/integrations\/|.*auth.*|.*payment.*|.*billing.*|.*secret.*|.*role.*|.*permission.*|\.github\/workflows\/)/i;

/** Sensitive auth/payment/secrets/permissions/CI paths or deletions → sensitive risk. */
export function classifyRisk(files: { path: string; deleted?: boolean }[]): Risk {
  if (files.some((f) => f.deleted || SENSITIVE.test(f.path))) return "sensitive";
  return files.length > 3 ? "medium" : "low";
}

/** Approval allows exactly one action. Draft PRs and reading checks never merge or deploy. */
export function canExecute(t: { state: State; approved_action: string | null; paused: boolean; attempts: number; max_attempts: number }): string | null {
  if (t.paused) return "Task is paused.";
  if (t.state !== "approved") return `Task must be approved first (is ${t.state}).`;
  if (t.approved_action !== "open_draft_pr" && t.approved_action !== "read_checks") return "No specific approved action.";
  if (t.attempts >= t.max_attempts) return "Retry limit reached.";
  return null;
}

/** Owner approval needs a prepared branch and recorded test evidence (even "not runnable"). */
export function canApprove(t: { state: State; branch: string | null; test_evidence: Record<string, unknown> }): string | null {
  if (t.state !== "awaiting_approval") return `Only tasks awaiting approval can be approved (is ${t.state}).`;
  if (!t.branch) return "No prepared branch.";
  if (!("status" in t.test_evidence)) return "No test evidence recorded.";
  return null;
}

export function idempotencyKey(taskId: string, action: ApprovedAction, attempt: number): string {
  return `${taskId}:${action}:${attempt}`;
}

/** Rotates through authorized projects after the last one inspected. */
export function nextProject<T extends { id: string }>(projects: T[], lastId: string | null): T | null {
  if (!projects.length) return null;
  const i = lastId ? projects.findIndex((p) => p.id === lastId) : -1;
  return projects[(i + 1) % projects.length] ?? null;
}

export function quotaLeft(quota: number, createdToday: number): number {
  return Math.max(0, quota - createdToday);
}

/** Exponential backoff for automatic retries: 5 min, 20 min, 80 min… capped at 6 h. */
export function backoffMs(attempts: number): number {
  return Math.min(6 * 3600_000, 5 * 60_000 * 4 ** Math.max(0, attempts - 1));
}

export const IN_FLIGHT: State[] = ["analyzing", "patch_prepared", "testing", "approved", "executing", "verifying"];

/** Daily run budget; resets when the UTC day changes. */
export function budget(s: { runs_today: number; runs_day: string | null; max_runs_per_day: number }, today: string): { allowed: boolean; runsToday: number } {
  const runsToday = s.runs_day === today ? s.runs_today : 0;
  return { allowed: runsToday < s.max_runs_per_day, runsToday };
}

/** Highest priority first, then oldest. */
export function pickNext<T extends { priority: number; created_at: string }>(tasks: T[]): T | null {
  return [...tasks].sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at))[0] ?? null;
}

/** Transient connector errors are retried later; anything else fails for owner review. */
export function isTransient(msg: string): boolean {
  return /\b(429|500|502|503|504)\b|timeout|network|fetch failed|rate limit/i.test(msg);
}

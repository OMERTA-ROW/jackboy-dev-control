// Read-only loader for approval-card deep links (/approvals/$requestId). It reads with the signed-in owner's own
// client (RLS applies), returns only what the card needs, and never writes: opening a link cannot approve, start
// or change anything. Unknown ids and other accounts' cards return the same bare "invalid" answer.
import { approvalCardView, isRequestId } from "./action-approval";
import { CODE_ACTION, type CodeCard } from "./code";
import { globalPauseReason } from "./global-pause";

type Result<T> = PromiseLike<{ data: T | null; error: unknown }>;
type Query = { select(c: string): Query; eq(k: string, v: unknown): Query; limit(n: number): Query; maybeSingle<T = Record<string, unknown>>(): Result<T> };
export type CardClient = { from(table: string): Query; rpc(name: "my_role"): PromiseLike<{ data: unknown; error?: unknown }> };
export type CardDeps = { codeCard: (id: string, userId: string) => Promise<CodeCard> };

export type CardOutcome = { summary: string; taskState: string | null; prUrl: string | null; runUrl: string | null; readFailed: boolean };
export type CardDetails = {
  id: string; kind: "code" | "foundry"; action: string; tier: string; title: string; target: string;
  whatRuns: string[]; diffSummary: string | null; costCap: string; expiresAt: string; taskId: string | null;
};
export type ApprovalCardResult =
  | { state: "invalid" }
  | { state: "expired" }
  | { state: "unavailable"; reason: string }
  | { state: "pending"; card: CardDetails; decideBlocked: string | null }
  | { state: "decided"; status: string; decidedAt: string | null; card: CardDetails; outcome: CardOutcome };

const COLUMNS = "id, task_id, action, tier, risk, status, outcome, expires_at, decided_at, requested_by, resources, permissions, diff_summary";
type Row = { id: string; task_id: string | null; action: string; tier: string; risk: string | null; status: string; outcome: string | null; expires_at: string; decided_at: string | null; requested_by: string | null; resources: unknown; permissions: string[] | null; diff_summary: string | null };

type TaskRow = { title: string | null; state: string | null; pr_url: string | null; blocked_reason: string | null };

const money = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? `$${n.toFixed(2)}` : null);
const prLink = (v: unknown) => (typeof v === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(v) ? v : null);

function details(r: Row, taskTitle: string | null): CardDetails {
  const res = (r.resources ?? {}) as { repo?: unknown; branch?: unknown; instruction?: unknown; taskBudgetUsd?: unknown };
  const repo = typeof res.repo === "string" ? res.repo : "unknown repository";
  if (r.action === CODE_ACTION) {
    const cap = money(res.taskBudgetUsd);
    return {
      id: r.id, kind: "code", action: r.action, tier: r.tier, title: "CODE request", target: repo,
      whatRuns: [typeof res.instruction === "string" ? res.instruction : "(instruction not recorded)", ...(r.permissions ?? [])],
      diffSummary: null,
      costCap: cap ? `Up to ${cap} for this job, held before it starts; the daily CODE limit still applies.` : "Not recorded — CODE will not start without a spend hold.",
      expiresAt: r.expires_at, taskId: null,
    };
  }
  return {
    id: r.id, kind: "foundry", action: r.action, tier: r.tier, title: taskTitle ?? "Code Foundry action",
    target: `${repo}${typeof res.branch === "string" ? ` · ${res.branch}` : ""}`,
    whatRuns: r.permissions ?? [], diffSummary: r.diff_summary,
    costCap: "No paid AI calls: this step only uses GitHub (draft PR or check results).",
    expiresAt: r.expires_at, taskId: r.task_id,
  };
}

export async function loadApprovalCard(sb: CardClient, userId: string, id: unknown, deps: CardDeps, now = Date.now()): Promise<ApprovalCardResult> {
  if (!isRequestId(id)) return { state: "invalid" };
  const role = await sb.rpc("my_role");
  if (role.data !== "owner") return { state: "invalid" };
  const read = await sb.from("action_requests").select(COLUMNS).eq("id", id.toLowerCase()).maybeSingle<Row>();
  if (read.error) return { state: "unavailable", reason: "This approval card can't be read right now. Nothing was changed." };
  const row = read.data;
  // Ownership and expiry are decided before anything else is read, so other accounts learn nothing.
  const pre = approvalCardView(row, userId, null, now);
  if (pre.state === "invalid" || pre.state === "expired") return pre;
  const r = row!;

  let task: TaskRow | null = null as TaskRow | null;
  let taskReadFailed = false;
  if (r.action !== CODE_ACTION && r.task_id) {
    const t = await sb.from("foundry_tasks").select("title, state, pr_url, blocked_reason").eq("id", r.task_id).maybeSingle<TaskRow>();
    if (t.error) taskReadFailed = true; else task = t.data;
  }
  const card = details(r, task?.title ?? null);

  if (pre.state === "pending") {
    const pol = await sb.from("automation_policy").select("paused").eq("id", 1).maybeSingle<{ paused: unknown }>();
    const view = approvalCardView(r, userId, globalPauseReason(pol.data, Boolean(pol.error)), now);
    return { state: "pending", card, decideBlocked: view.state === "pending" ? view.decideBlocked : null };
  }

  // Decided: the outcome comes from the task/run itself, never from the decision alone.
  let outcome: CardOutcome;
  if (r.action === CODE_ACTION) {
    if (r.status !== "allowed") outcome = { summary: r.outcome ?? `Request ${r.status}. Nothing was dispatched.`, taskState: null, prUrl: null, runUrl: null, readFailed: false };
    else {
      try {
        const c = await deps.codeCard(r.id, userId);
        const run = c.run;
        outcome = {
          summary: [c.outcome, run ? `GitHub run: ${run.status}${run.conclusion ? ` (${run.conclusion})` : ""}.` : null].filter(Boolean).join(" ") || "No run evidence yet.",
          taskState: run ? run.conclusion ?? run.status : null,
          prUrl: run?.pr ?? null,
          runUrl: run?.url ?? null,
          readFailed: false,
        };
      } catch {
        outcome = { summary: "The run couldn't be read from GitHub right now. Nothing is assumed — try again shortly.", taskState: null, prUrl: null, runUrl: null, readFailed: true };
      }
    }
  } else if (taskReadFailed || !task) {
    outcome = { summary: "The task couldn't be read right now. Nothing is assumed.", taskState: null, prUrl: null, runUrl: null, readFailed: true };
  } else {
    outcome = {
      summary: `Task is ${task.state ?? "unknown"}${task.blocked_reason ? ` (${task.blocked_reason})` : ""}.`,
      taskState: task.state,
      prUrl: prLink(task.pr_url),
      runUrl: null,
      readFailed: false,
    };
  }
  return { state: "decided", status: r.status, decidedAt: r.decided_at, card, outcome };
}

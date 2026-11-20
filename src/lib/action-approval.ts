// Approval cards for Code Foundry actions. Pure rules; server code in action-approval.server.ts.
export type Tier = "routine" | "controlled" | "critical";
export type Mode = "once" | "task";
export type Decision = "allow_once" | "allow_task" | "deny";
export const REQUEST_TTL_MS = 15 * 60_000;

/** Routine = read-only within scope; Controlled = branch/PR/tests; Critical = deploy, destructive, security/config/credential changes. */
export function classifyTier(action: string, risk: string): Tier {
  if (["production_deploy", "merge", "delete", "credential_change", "permission_change"].includes(action)) return "critical";
  if (risk === "sensitive") return "critical";
  if (["read_checks", "scan", "inspect"].includes(action)) return "routine";
  return "controlled";
}

export const PERMISSIONS: Record<string, string[]> = {
  open_draft_pr: ["Read repository", "Push to the prepared jackboy/* branch", "Open a DRAFT pull request (never merge)"],
  read_checks: ["Read GitHub check results"],
};

export type Req = { status: string; expires_at: string; tier: Tier; requested_by: string };
/** Decide whether a decision may be applied. Identity is the session user; passkey grant needed for Critical. */
export function canDecide(r: Req | null, userId: string, decision: Decision, hasPasskeyGrant: boolean, now = Date.now()): string | null {
  if (!r) return "Request not found.";
  if (r.status !== "pending") return `Already ${r.status}.`;
  if (!Number.isFinite(Date.parse(r.expires_at)) || Date.parse(r.expires_at) <= now) return "This request expired. Ask again.";
  if (r.requested_by !== userId) return "This request belongs to another session user.";
  if (decision === "deny") return null;
  if (r.tier === "critical" && !hasPasskeyGrant) return "Critical action: passkey confirmation required (voice or a click alone is not enough).";
  if (r.tier === "critical" && decision === "allow_task") return "Critical actions can only be allowed once.";
  return null;
}

/** "Allow for this task" covers later non-critical actions on the same task until it ends. */
export function coveredByTask(prior: { task_id: string | null; mode: string | null; status: string; tier: Tier }[], taskId: string, tier: Tier): boolean {
  return tier !== "critical" && prior.some((p) => p.task_id === taskId && p.mode === "task" && p.status === "allowed");
}


const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isRequestId(id: unknown): id is string {
  return typeof id === "string" && REQUEST_ID.test(id);
}
/** Deep link to one approval card: a relative path holding only the request id — never a nonce, token or secret.
 * Anything that isn't a plain request id falls back to the general Approvals page. */
export function approvalCardLink(id: string): string {
  return isRequestId(id) ? `/approvals/${id.toLowerCase()}` : "/updates";
}

export type CardRow = { status: string; expires_at: string; requested_by: string | null };
export type CardView =
  | { state: "invalid" }
  | { state: "expired" }
  | { state: "decided"; status: string }
  | { state: "pending"; decideBlocked: string | null };
/** What a deep link may show. Unknown cards and other accounts' cards look identical ("invalid").
 * Viewing never decides anything; a pending card can be decided only through its existing decision path,
 * and the Kill Switch (on or unreadable) keeps the decision buttons blocked. */
export function approvalCardView(r: CardRow | null, userId: string, killSwitchReason: string | null, now = Date.now()): CardView {
  if (!r || !userId || !r.requested_by || r.requested_by !== userId) return { state: "invalid" };
  if (r.status === "pending" || r.status === "expired") {
    const expires = Date.parse(r.expires_at);
    if (r.status === "expired" || !Number.isFinite(expires) || expires <= now) return { state: "expired" };
    return { state: "pending", decideBlocked: killSwitchReason };
  }
  return { state: "decided", status: r.status };
}

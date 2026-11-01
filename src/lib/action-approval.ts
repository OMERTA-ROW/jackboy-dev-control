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
  if (new Date(r.expires_at).getTime() <= now) return "This request expired. Ask again.";
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

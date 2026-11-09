/** CODE's browser-safe contract. GitHub is the durable runner; no credentials cross this boundary. */
export const CODE_ACTION = "code_workflow";
export const CODE_WORKFLOW = "code.yml";
export const CODE_TTL = 15 * 60_000;
export const CODE_PERMISSIONS = ["Read the selected repository", "Run Codex and tests in an isolated GitHub runner", "Write only a jackboy/code-* branch and open a draft PR", "No merge, deployment, permissions, credentials, or agent handoff"];
export type CodeScope = { repo: string; ref: string; workflowSha: string; baseSha: string; instruction: string; sessionHash: string; correlation: string; operation: "dispatch" | "retry"; taskBudgetUsd?: number; runId?: number; lane?: "auto"; acceptance?: true };
export type CodeRunJob = { name: string; status: string; conclusion: string | null };
export type CodeRunProgress = { completed: number; total: number; percent: number };
export function codeRunProgress(jobs: CodeRunJob[]): CodeRunProgress | null {
  if (jobs.length === 0) return null;
  const completed = jobs.filter((job) => job.status === "completed").length;
  return { completed, total: jobs.length, percent: Math.round((completed / jobs.length) * 100) };
}
/** Real records for the acceptance test: publish gate decision, money held/returned and provider calls. */
export type AcceptanceEvidence = {
  publishGate: { ok: boolean; reasons: string[]; at: string } | null;
  hold: { reservedUsd: number; releasedUsd: number; status: string } | null;
  calls: { count: number; actualUsd: number; models: string[] };
};
export type CodeCard = { id: string; projectId: string; repo: string; instruction: string; status: string; expiresAt: string; nonce?: string; permissions: string[]; outcome: string | null; taskBudgetUsd?: number | null; acceptance?: { ok: boolean | null; reasons: string[] }; acceptanceEvidence?: AcceptanceEvidence; run?: { id: number; status: string; conclusion: string | null; updatedAt?: string | null; url: string; jobs: CodeRunJob[]; downloads: { name: string; url: string }[]; pr: string | null } };
export function parseCodeCommand(text: string): { project: string; instruction: string } | null {
  const m = /^\s*CODE\s+([^:\n]{1,120}):\s*([\s\S]{1,2000})$/i.exec(text);
  return m?.[1]?.trim() && m[2]?.trim() ? { project: m[1].trim(), instruction: m[2].trim() } : null;
}
/** A generic yes/confirm never authorizes a CODE action. The full pending request ID must be named. */
export function codeVoiceDecision(text: string, pendingId: string): "allow" | "deny" | null {
  const m = /^\s*(allow|deny)\s+CODE\s+([a-f0-9-]{36})[.!]?\s*$/i.exec(text);
  return m && m[2]?.toLowerCase() === pendingId.toLowerCase() ? m[1]!.toLowerCase() as "allow" | "deny" : null;
}
export function codeApprovalError(r: { status: string; expires_at: string; requested_by: string; resources: CodeScope }, userId: string, sessionHash: string, now = Date.now()): string | null {
  if (r.status !== "pending") return "This CODE request has already been decided.";
  const expires = Date.parse(r.expires_at);
  if (!Number.isFinite(expires) || expires <= now) return "This CODE approval expired. Request a new job.";
  if (r.requested_by !== userId || r.resources.sessionHash !== sessionHash) return "This CODE request belongs to another authenticated session.";
  return null;
}
export function codeRunName(id: string) { return `CODE ${id}`; }
/** Validate GitHub links against both the origin and the job's repository. */
export function codeLink(value: unknown, repo: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    if (u.origin !== "https://github.com" || u.username || u.password || u.hash) return null;
    const prefix = `/${repo}/`;
    return u.pathname.startsWith(prefix) && /^(actions\/runs\/\d+(\/artifacts\/\d+)?|pull\/\d+)\/?$/.test(u.pathname.slice(prefix.length)) ? u.href : null;
  } catch { return null; }
}

// Single source of truth for where an update proposal sits in the owner's workflow.
// "pending" = a distinct request that needs the owner's decision right now. Nothing else is counted.
import type { ProposalStatus } from "./update-writer";

export type Bucket = "pending" | "in_progress" | "action_required" | "history";
export type ProposalLike = { id: string; status: string; checks_state?: string | null; delivery_error?: string | null; has_files?: boolean; has_repo?: boolean };

export function bucketOf(p: ProposalLike): { bucket: Bucket; reason: string } {
  const s = p.status as ProposalStatus;
  if (s === "draft") return { bucket: "pending", reason: "Needs your approval" };
  if (s === "pr_open") {
    if (p.checks_state === "pending") return { bucket: "in_progress", reason: "Pull request open; build checks running" };
    if (p.checks_state === "failure") return { bucket: "action_required", reason: "Build checks failed on the pull request" };
    return { bucket: "pending", reason: "Pull request ready: approve the merge (new scope)" };
  }
  if (s === "approved") {
    if (p.delivery_error) return { bucket: "action_required", reason: `Approved, but opening the pull request failed: ${p.delivery_error}` };
    if (p.has_files && p.has_repo) return { bucket: "in_progress", reason: "Approved; opening the pull request" };
    return { bucket: "action_required", reason: "Approved. No code was generated, so copy the build prompt to OMNI and mark it sent" };
  }
  return { bucket: "history", reason: s };
}

export function groupProposals<T extends ProposalLike>(rows: T[]) {
  const seen = new Set<string>();
  const out: Record<Bucket, (T & { reason: string })[]> = { pending: [], in_progress: [], action_required: [], history: [] };
  for (const r of rows) {
    if (seen.has(r.id)) continue; seen.add(r.id);
    const b = bucketOf(r); out[b.bucket].push({ ...r, reason: b.reason });
  }
  return out;
}

/** Apply an optimistic approval locally before the server confirms. */
export function optimisticApprove<T extends ProposalLike>(rows: T[], id: string): T[] {
  return rows.map((r) => (r.id === id && r.status === "draft" ? { ...r, status: "approved" } : r));
}

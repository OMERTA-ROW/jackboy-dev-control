// Pure rules for multi-project batch actions on the Projects page.
import type { HubProject, HubScan } from "./project-hub";

export type BatchAction = "scan" | "repair" | "distribute";
export type Eligibility = { ok: true } | { ok: false; reason: string };
export type BatchProposal = { id: string; project_id: string; status: string; pr_url: string | null };

export const MAX_CONCURRENCY = 2;

/** Why a project can or cannot run an action; disconnected projects are skipped with an actionable reason. */
export function eligible(action: BatchAction, p: HubProject, lastScan: HubScan | undefined, proposals: BatchProposal[]): Eligibility {
  if (action === "scan") return p.site_url ? { ok: true } : { ok: false, reason: "Add a site address first" };
  if (action === "repair") {
    if (!p.site_url) return { ok: false, reason: "Add a site address first" };
    if (!lastScan || lastScan.status !== "done" && lastScan.status !== "completed") return { ok: false, reason: "Scan it first" };
    const f = Array.isArray(lastScan.findings) ? (lastScan.findings as { severity?: string }[]) : [];
    return f.some((x) => x.severity !== "low") ? { ok: true } : { ok: false, reason: "No medium or high issues to repair" };
  }
  if (!p.github_repo) return { ok: false, reason: "Connect a private GitHub repo first" };
  return approvedUndelivered(p.id, proposals).length ? { ok: true } : { ok: false, reason: "No approved updates waiting" };
}

export function approvedUndelivered(projectId: string, proposals: BatchProposal[]): BatchProposal[] {
  return proposals.filter((x) => x.project_id === projectId && x.status === "approved" && !x.pr_url);
}

/** Keep only ids that still exist (drops projects the owner can no longer see). */
export function sanitizeSelection(saved: unknown, existing: string[]): string[] {
  if (!Array.isArray(saved)) return [];
  const ok = new Set(existing);
  return [...new Set(saved.filter((x): x is string => typeof x === "string" && ok.has(x)))];
}

/** Run tasks with at most `limit` in flight; each result is independent (one failure never stops the others). */
export async function runBounded<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>, onDone?: (t: T, r: { ok: true; value: R } | { ok: false; error: string }) => void) {
  const out: Array<{ ok: true; value: R } | { ok: false; error: string }> = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      const t = items[idx]!;
      try { out[idx] = { ok: true, value: await fn(t) }; } catch (e) { out[idx] = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
      onDone?.(t, out[idx]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

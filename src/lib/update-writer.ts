// Pure rules for the automatic update writer (testable, no I/O).
export const FREQUENCIES = [
  { hours: 0, label: "Off (Run now only)" },
  { hours: 6, label: "Every 6 hours" },
  { hours: 12, label: "Every 12 hours" },
  { hours: 24, label: "Daily" },
  { hours: 72, label: "Every 3 days" },
  { hours: 168, label: "Weekly" },
] as const;
export const FREQUENCY_HOURS = FREQUENCIES.map((f) => f.hours) as readonly number[];

export const STATUSES = ["draft", "pr_open", "approved", "merged", "rejected", "reverted", "sent_to_omni"] as const;
export type ProposalStatus = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<ProposalStatus, string> = {
  draft: "Draft", pr_open: "PR open", approved: "Approved", merged: "Merged", rejected: "Rejected", reverted: "Reverted", sent_to_omni: "Sent to OMNI",
};

/** Max projects reviewed per run, so one run can never fan out unbounded. */
export const BATCH_SIZE = 5;
/** Max files a single generated change may touch. */
export const MAX_FILES = 8;
export const MAX_FILE_BYTES = 60_000;

/**
 * Allowed manual status moves. Repo-backed moves (pr_open → merged, merged → reverted)
 * happen only through the merge/revert actions, never by setting status directly.
 */
export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  if (from === to) return false;
  if (from === "draft") return to === "approved" || to === "rejected";
  if (from === "approved") return to === "sent_to_omni" || to === "rejected" || to === "draft";
  if (from === "rejected") return to === "draft";
  if (from === "pr_open") return to === "rejected";
  return false;
}

/** A PR may be merged only when GitHub reports passing checks, or the owner explicitly accepts "no checks configured". */
export function canMerge(status: ProposalStatus, checks: string | null, acceptNoChecks: boolean): { ok: boolean; reason: string } {
  if (status !== "pr_open") return { ok: false, reason: "Only an open pull request can be merged." };
  if (checks === "success") return { ok: true, reason: "Checks passed." };
  if (checks === "none" && acceptNoChecks) return { ok: true, reason: "No checks configured; owner accepted." };
  if (checks === "none") return { ok: false, reason: "This repo has no build checks. Confirm to merge anyway." };
  if (checks === "failure") return { ok: false, reason: "Build checks failed." };
  return { ok: false, reason: "Build checks are still running or unknown. Refresh checks first." };
}

/** Scheduled run is due when frequency is on and enough time passed since the last run. */
export function isDue(frequencyHours: number, lastRunAt: string | null, now = Date.now()): boolean {
  if (!frequencyHours) return false;
  if (!lastRunAt) return true;
  return now - new Date(lastRunAt).getTime() >= frequencyHours * 3600_000 - 5 * 60_000;
}

/** Monthly spending cap: true when another unit is allowed. Cap 0 means nothing is allowed. */
export function underCap(usedThisMonth: number, cap: number): boolean {
  return usedThisMonth < cap;
}
export function monthStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Only owner/repo with safe characters. */
export function parseRepo(v: string): { owner: string; repo: string } | null {
  const m = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(v.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** Reject paths that escape the repo or touch git internals / CI secrets / workflows. */
export function safePath(p: string): boolean {
  if (!p || p.length > 300 || p.startsWith("/") || p.includes("\\")) return false;
  const parts = p.split("/");
  if (parts.some((s) => s === ".." || s === "." || s === "")) return false;
  if (parts[0] === ".git" || p.startsWith(".github/workflows/")) return false;
  if (/(^|\/)\.env($|\.)/.test(p)) return false;
  return true;
}

export type FileChange = { path: string; content: string };
export type ProposalDraft = { title: string; what_to_change: string; why: string; build_prompt: string; files: FileChange[] };

export function parseProposal(raw: string): ProposalDraft {
  const o = JSON.parse(raw) as Record<string, unknown>;
  const pick = (k: "title" | "what_to_change" | "why" | "build_prompt", max: number) => {
    const v = o[k];
    if (typeof v !== "string" || !v.trim()) throw new Error(`AI response missing ${k}`);
    return v.trim().slice(0, max);
  };
  const rawFiles = Array.isArray(o["files"]) ? (o["files"] as unknown[]) : [];
  const files: FileChange[] = [];
  for (const f of rawFiles.slice(0, MAX_FILES)) {
    const r = f as { path?: unknown; content?: unknown };
    if (typeof r.path !== "string" || typeof r.content !== "string") continue;
    if (!safePath(r.path) || r.content.length > MAX_FILE_BYTES) continue;
    files.push({ path: r.path, content: r.content });
  }
  return { title: pick("title", 200), what_to_change: pick("what_to_change", 4000), why: pick("why", 3000), build_prompt: pick("build_prompt", 12000), files };
}

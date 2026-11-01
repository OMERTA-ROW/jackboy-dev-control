// Pure rules for the automatic update writer (testable, no I/O).
export const FREQUENCIES = [
  { hours: 0, label: "Off (Run now only)" },
  { hours: 6, label: "Every 6 hours" },
  { hours: 12, label: "Every 12 hours" },
  { hours: 24, label: "Daily" },
  { hours: 72, label: "Every 3 days" },
  { hours: 168, label: "Weekly" },
] as const;

export const STATUSES = ["draft", "approved", "rejected", "sent_to_omni"] as const;
export type ProposalStatus = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<ProposalStatus, string> = { draft: "Draft", approved: "Approved", rejected: "Rejected", sent_to_omni: "Sent to OMNI" };

/** Max projects reviewed per run, so one run can never fan out unbounded. */
export const BATCH_SIZE = 5;

/** Allowed status moves. "Sent to OMNI" is an owner mark after pasting the prompt; only approved proposals qualify. */
export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  if (from === to) return false;
  if (from === "draft") return to === "approved" || to === "rejected";
  if (from === "approved") return to === "sent_to_omni" || to === "rejected" || to === "draft";
  if (from === "rejected") return to === "draft";
  return false;
}

/** Scheduled run is due when frequency is on and enough time passed since the last run. */
export function isDue(frequencyHours: number, lastRunAt: string | null, now = Date.now()): boolean {
  if (!frequencyHours) return false;
  if (!lastRunAt) return true;
  return now - new Date(lastRunAt).getTime() >= frequencyHours * 3600_000 - 5 * 60_000;
}

export type ProposalDraft = { title: string; what_to_change: string; why: string; build_prompt: string };

export function parseProposal(raw: string): ProposalDraft {
  const o = JSON.parse(raw) as Record<string, unknown>;
  const pick = (k: keyof ProposalDraft, max: number) => {
    const v = o[k];
    if (typeof v !== "string" || !v.trim()) throw new Error(`AI response missing ${k}`);
    return v.trim().slice(0, max);
  };
  return { title: pick("title", 200), what_to_change: pick("what_to_change", 4000), why: pick("why", 3000), build_prompt: pick("build_prompt", 12000) };
}

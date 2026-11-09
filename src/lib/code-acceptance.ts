/** First controlled CODE acceptance test: one fixed, docs-only, reviewed-lane request.
 * Pure rules shared by the Settings card, the server handler and tests. */
export const ACCEPTANCE_FILE = "docs/CODE-ACCEPTANCE.md";
export const ACCEPTANCE_PROJECT = "Jackboy Dev Control";
export const ACCEPTANCE_REPO = "OMERTA-ROW/jackboy-dev-control";
export const ACCEPTANCE_MAX_HOLD_USD = 1;

export function acceptanceTarget(repo: string): string {
  return `code_acceptance:${repo}`;
}

/** The instruction is fixed by the server; the owner cannot edit it. */
export function acceptanceInstruction(now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return `Append exactly one line "Acceptance test ${day}" to ${ACCEPTANCE_FILE} (create the file if missing). Change no other file. Open a draft PR only.`;
}

export type AcceptanceGates = {
  enabled: boolean | null;
  killSwitch: boolean | null;
  globalPaused: boolean | null;
  activeRequestId: string | null;
  perTaskReserveUsd: number | null;
  allowed: boolean; // repo is on the allow list with a pinned workflow
};

/** Returns why the test can't start, or null when every gate passes. */
export function acceptanceBlockReason(g: AcceptanceGates): string | null {
  if (g.enabled !== true) return "CODE is off.";
  if (g.killSwitch !== false) return "The CODE emergency stop is on.";
  if (g.globalPaused !== false) return "The Kill Switch is on.";
  if (g.activeRequestId) return "Another CODE run is still active.";
  if (g.perTaskReserveUsd === null || !(g.perTaskReserveUsd > 0) || g.perTaskReserveUsd > ACCEPTANCE_MAX_HOLD_USD)
    return `The per-task hold must be above $0 and no more than $${ACCEPTANCE_MAX_HOLD_USD}.`;
  if (!g.allowed) return `${ACCEPTANCE_REPO} is not on the CODE allow list.`;
  return null;
}

export type PrFile = { filename: string; status: string; deletions: number };
/** The draft PR may only add or modify the one acceptance file, with no deleted lines. */
export function acceptanceFilesCheck(files: PrFile[]): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (files.length === 0) reasons.push("The draft PR changes no files.");
  for (const f of files) {
    if (f.filename !== ACCEPTANCE_FILE) reasons.push(`${f.filename} is outside the allowed file.`);
    else if (f.status !== "added" && f.status !== "modified") reasons.push(`${f.filename} was ${f.status}.`);
    else if (f.deletions > 0) reasons.push(`${f.filename} had lines deleted.`);
  }
  return { ok: reasons.length === 0, reasons };
}

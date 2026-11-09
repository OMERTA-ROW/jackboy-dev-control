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

export const ACCEPTANCE_MAX_ADDED_LINES = 5;
export const ACCEPTANCE_MAX_PATCH_BYTES = 64 * 1024;
type Check = { ok: boolean; reasons: string[] };

/** Fail-closed check of the exact model patch BEFORE the draft PR is published.
 * Only additions to the one acceptance file are allowed: no other file, deletion, rename, mode change or binary. */
export function acceptancePatchCheck(patch: string): Check {
  const reasons: string[] = [];
  const add = (r: string) => {
    if (!reasons.includes(r) && reasons.length < 6) reasons.push(r);
  };
  if (patch.length > ACCEPTANCE_MAX_PATCH_BYTES) return { ok: false, reasons: ["The patch is larger than allowed."] };
  if (!patch.trim()) return { ok: false, reasons: ["The patch is empty."] };
  const F = ACCEPTANCE_FILE;
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let files = 0;
  let added = 0;
  let dated = false;
  let inHunk = false;
  const hunk = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/;
  const show = (l: string) => l.slice(0, 80);
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      files++;
      inHunk = false;
      if (line !== `diff --git a/${F} b/${F}`) add(`Changes a file other than ${F}: ${show(line.slice(11))}`);
      continue;
    }
    if (files === 0) {
      add("The patch has content before its first file.");
      continue;
    }
    if (!inHunk) {
      if (
        /^index [0-9a-f]{7,64}\.\.[0-9a-f]{7,64}( 100644)?$/.test(line) ||
        line === "new file mode 100644" ||
        line === `--- a/${F}` ||
        line === "--- /dev/null" ||
        line === `+++ b/${F}`
      )
        continue;
      if (hunk.test(line)) {
        inHunk = true;
        continue;
      }
      add(`Unexpected patch header: ${show(line)}`);
      continue;
    }
    if (line.startsWith("+")) {
      added++;
      if (line.length > 201) add("An added line is too long.");
      if (/^\+.*Acceptance test \d{4}-\d{2}-\d{2}/.test(line)) dated = true;
    } else if (line.startsWith("-")) add("The patch deletes or rewrites existing lines.");
    else if (line.startsWith(" ") || line === "\\ No newline at end of file") continue;
    else if (hunk.test(line)) continue;
    else add(`Unexpected patch line: ${show(line)}`);
  }
  if (files !== 1) add(`The patch must change exactly one file (found ${files}).`);
  if (added === 0) add("The patch adds no lines.");
  if (added > ACCEPTANCE_MAX_ADDED_LINES) add(`The patch adds ${added} lines; at most ${ACCEPTANCE_MAX_ADDED_LINES} are allowed.`);
  if (added > 0 && !dated) add("The patch doesn't contain the dated acceptance line.");
  return { ok: reasons.length === 0, reasons };
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

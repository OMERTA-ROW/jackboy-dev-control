// CODE Undo rules (pure, tested). Undo never calls AI and costs nothing. A draft PR is simply closed
// (branch kept). A merged change gets a revert that restores each touched file exactly; it needs a fresh
// passkey and is refused when newer work changed the same files, so it never overwrites anything.

export type PrState = { state: "open" | "closed"; merged: boolean; draft: boolean };
export type UndoKind = "close_draft" | "revert_merged";
export const UNDO_STEP_UP = "code_undo";
export const undoTarget = (requestId: string) => `code_undo:${requestId}`;
export const MAX_REVERT_FILES = 40;

export function undoKind(pr: PrState): UndoKind | null {
  if (pr.merged) return "revert_merged";
  if (pr.state === "open") return "close_draft";
  return null; // closed without merging: nothing to undo
}
export const undoNeedsPasskey = (kind: UndoKind) => kind === "revert_merged";

export type UndoContext = {
  kind: UndoKind | null;
  killSwitch: boolean | null;
  repoAllowed: boolean;
  existing: { status: string } | null;
};
/** Why Undo can't run right now, in plain words; null when it can. */
export function undoBlockReason(c: UndoContext): string | null {
  if (c.existing && c.existing.status !== "failed") return c.existing.status === "done" ? "This change was already undone." : "Undo is already in progress for this change.";
  if (c.kind === null) return "The PR was closed without merging, so there is nothing to undo.";
  if (c.killSwitch !== false) return c.killSwitch === null ? "The Kill Switch state can't be read, so Undo is blocked." : "The Kill Switch is on. Turn it off before undoing.";
  if (!c.repoAllowed) return "This site isn't on the CODE allowed list, so Undo is blocked.";
  return null;
}

export type PrFile = { filename: string; status: string; previous_filename?: string };
/** Files changed on main since the merge (their current version differs from what the merge left). */
export function revertClashes(files: { path: string; afterMerge: string | null; onMainNow: string | null }[]): string[] {
  return files.filter((f) => f.afterMerge !== f.onMainNow).map((f) => f.path);
}

/** Paths whose before-merge version must be read, and paths that must be deleted to undo the change. */
export function revertPlan(files: PrFile[]): { restore: string[]; remove: string[]; touched: string[]; error: string | null } {
  if (!files.length) return { restore: [], remove: [], touched: [], error: "The PR has no file changes to undo." };
  if (files.length > MAX_REVERT_FILES) return { restore: [], remove: [], touched: [], error: `The change touches ${files.length} files; one-press Undo handles up to ${MAX_REVERT_FILES}. Revert it in GitHub instead.` };
  const restore = new Set<string>(), remove = new Set<string>();
  for (const f of files) {
    if (f.status === "added" || f.status === "copied") remove.add(f.filename);
    else if (f.status === "renamed") { remove.add(f.filename); if (f.previous_filename) restore.add(f.previous_filename); }
    else restore.add(f.filename); // modified, changed, removed
  }
  const touched = [...new Set([...restore, ...remove])];
  return { restore: [...restore], remove: [...remove], touched, error: null };
}

/** Next step for a revert waiting on checks. Jackboy merges only its own revert, only after checks pass. */
export function revertNextStep(checks: "success" | "failure" | "pending" | "none", waitingSinceMs: number, now = Date.now()): "merge" | "wait" | "fail_checks" | "fail_no_checks" {
  if (checks === "success") return "merge";
  if (checks === "failure") return "fail_checks";
  if (checks === "none" && now - waitingSinceMs > 30 * 60_000) return "fail_no_checks";
  return "wait";
}

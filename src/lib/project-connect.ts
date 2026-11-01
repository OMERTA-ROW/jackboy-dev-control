// Pure rules for mapping a Jackboy project to a GitHub repository. Suggestions never link anything by themselves.

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter((w) => w.length > 1 && !["inc", "the", "app", "platform", "internal", "build"].includes(w));

/** Token-overlap score between a project name and a repo's name (owner ignored). 0..1 */
export function matchScore(project: string, repoFull: string): number {
  const a = new Set(norm(project)), b = new Set(norm(repoFull.split("/")[1] ?? repoFull));
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const w of a) if ([...b].some((x) => x === w || (w.length > 4 && (x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5)))))) hit++;
  return hit / Math.max(a.size, b.size);
}

export type RepoChoice = { repo: string; usable: boolean; visibility: string; org: string | null };
/** Best writable repo for a project, only when the match is clear (score ≥ 0.5). */
export function suggestRepo(project: string, repos: RepoChoice[]): RepoChoice | null {
  let best: RepoChoice | null = null, score = 0;
  for (const r of repos) { if (!r.usable) continue; const s = matchScore(project, r.repo); if (s > score) { best = r; score = s; } }
  return score >= 0.5 ? best : null;
}

export type ConnState = "not_connected" | "needs_approval" | "verifying" | "connected" | "blocked";
/** Truthful repo connection state from stored records only. */
export function connectionState(repo: string | null, grant: { status: string; last_error: string | null } | null): { state: ConnState; label: string } {
  if (!repo) return { state: "not_connected", label: "Not connected — no repository linked" };
  if (!grant || grant.status === "needs_approval" || grant.status === "missing") return { state: "needs_approval", label: "Repository linked, access not approved yet" };
  if (grant.status === "connected") return { state: "connected", label: "Connected — read, branch write and PR access verified" };
  if (grant.status === "awaiting_setup") return { state: "verifying", label: "Approved, waiting for verification" };
  return { state: "blocked", label: grant.last_error ? `Blocked: ${grant.last_error}` : `Blocked (${grant.status})` };
}

export const RESYNC_INTERVAL_MS = 15 * 60_000;
export type RepositoryReference = { table: string; id: string; field: string; value: string; mutable: boolean };
export type RepositoryCheck = { status: number; canonical?: string; reason?: string };
export type RepositoryProfileChange = { projectId: string; oldName: string; oldRepo: string | null; newName: string; agentProfiles: { id: string; name: string; repo_url: string | null }[] };
export type RepositoryReviewRow = { repo: string; proposed: string | null; group: "linked" | "missing" | "moved" | "deleted"; reason: string; mutable: number; historical: number; canApply: boolean; profiles?: RepositoryProfileChange[] };
export type RepoCandidate = { full_name: string; description?: string | null; homepage?: string | null };
export function projectRepoMatch(name: string, link: string | null, inventory: RepoCandidate[]): string | null {
  const projectId = link?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0];
  const linked = projectId ? inventory.filter((r) => `${r.description ?? ""} ${r.homepage ?? ""}`.includes(projectId)) : [];
  if (linked.length === 1) return linked[0]?.full_name ?? null;
  if (linked.length > 1) return null;
  const clean = name.replace(/\b(internal build|platform|data concierge|central intelligence|assist)\b/gi, "").trim();
  return closestRepo(`project/${clean}`, inventory.map((r) => r.full_name));
}
export function normalizeRepo(value: string): string {
  return value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git\/?$/i, "").replace(/\/$/, "");
}
function words(value: string) { return value.split("/").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? ""; }
function similarity(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min((current[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return 1 - (previous[b.length] ?? 0) / Math.max(a.length, b.length, 1);
}
export function closestRepo(repo: string, inventory: string[]): string | null {
  const name = words(repo);
  if (!name) return null;
  const candidates = inventory.map((r) => {
    const target = words(r);
    const score = target === name ? 1 : Math.max(similarity(name, target), similarity(name, target.replace(/companion$/, "")) * 0.9);
    return { repo: r, score };
  }).filter((x) => x.score >= 0.55).sort((a, b) => b.score - a.score);
  const first = candidates[0];
  return first && (!candidates[1] || first.score > candidates[1].score) ? first.repo : null;
}
export function buildRepositoryReview(refs: RepositoryReference[], inventory: string[], checks: Record<string, RepositoryCheck>): RepositoryReviewRow[] {
  const repos = [...new Set(refs.map((r) => normalizeRepo(r.value)))];
  return repos.map((repo) => {
    const references = refs.filter((r) => normalizeRepo(r.value).toLowerCase() === repo.toLowerCase());
    const mutable = references.filter((r) => r.mutable).length;
    const exact = inventory.find((r) => r.toLowerCase() === repo.toLowerCase());
    const check = checks[repo];
    const canonical = check?.canonical && inventory.find((r) => r.toLowerCase() === check.canonical?.toLowerCase());
    const linked = !!exact && check?.status === 200 && (!canonical || canonical.toLowerCase() === repo.toLowerCase());
    const proposed = linked ? null : canonical || closestRepo(repo, inventory.filter((r) => r.toLowerCase() !== repo.toLowerCase()));
    const uncertain = !check || (check.status !== 200 && check.status !== 404);
    return { repo, proposed: proposed || null, group: linked ? "linked" : proposed ? "moved" : "deleted", mutable, historical: references.length - mutable,
      canApply: mutable > 0 && !linked && !uncertain,
      reason: linked ? "Accessible to GITHUB_TOKEN" : uncertain ? check?.reason || "Verification incomplete; no removal allowed" : proposed ? "Proposed accessible match — confirm it is the same project" : "Deleted / not found by this token. This can also mean private, unselected, or org approval missing; deletion is not proven." };
  });
}
export function needsRepositoryCheck(last: string | null, invalidated: boolean, now = Date.now()): boolean {
  return !last || now - Date.parse(last) >= RESYNC_INTERVAL_MS || (invalidated && now - Date.parse(last) >= 60_000);
}
export function tokenOwnerWarning(login: string, repos: string[], appOwners: string[] = []): string | null {
  // Organization repos covered by a live GitHub App installation are routed through the App, not the token.
  const covered = appOwners.some((o) => o.toLowerCase() === "omerta-row");
  return !covered && login.toLowerCase() === "street-tech666" && repos.some((r) => r.toLowerCase().startsWith("omerta-row/"))
    ? "GITHUB_TOKEN belongs to street-Tech666 while saved repositories use OMERTA-ROW. Update GITHUB_TOKEN in Project Settings → Secrets with an organization-authorized token; account mismatch alone does not prove denied access." : null;
}
export type RepoReference = { table: string; id: string; field: string; value: string; mutable: boolean };
export function canonicalRepo(value: string): string | null {
  const clean = value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git\/?$/i, "").replace(/\/$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(clean) ? clean : null;
}
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
export function candidates(saved: string, accessible: string[]): string[] {
  const name = words(saved.split("/")[1] ?? saved);
  const score = (repo: string) => {
    const target = words(repo.split("/")[1] ?? repo);
    const overlap = name.filter(w => target.includes(w)).length;
    return overlap / Math.max(name.length, target.length) + (repo.toLowerCase().startsWith("omerta-row/") ? 0.05 : 0);
  };
  return accessible.filter(r => score(r) >= 0.4).sort((a, b) => score(b) - score(a) || a.localeCompare(b)).slice(0, 5);
}
export function reviewReferences(refs: RepoReference[], accessible: string[]) {
  return [...new Set(refs.map(r => canonicalRepo(r.value)).filter((r): r is string => !!r))].sort().map(repo => {
    const linked = accessible.find(a => a.toLowerCase() === repo.toLowerCase());
    return { repo, status: linked ? "linked" as const : "missing" as const, candidates: linked ? [] : candidates(repo, accessible), references: refs.filter(r => canonicalRepo(r.value)?.toLowerCase() === repo.toLowerCase()) };
  });
}

/** Fetch every page; never return a partial list as if it were complete. No org/public fallback. */
export async function listTokenRepositories(request: (path: string) => Promise<Response>) {
  const repos: string[] = [];
  for (let page = 1; page <= 100; page++) {
    const response = await request(`/user/repos?per_page=100&affiliation=owner,collaborator,organization_member&page=${page}`);
    if (!response.ok) {
      const body = await response.text();
      let message = response.statusText;
      try { message = String(JSON.parse(body).message ?? message); } catch { /* don't return raw bodies */ }
      throw new Error(`GitHub ${response.status}: ${message}`);
    }
    const rows = await response.json() as { full_name: string }[];
    if (!Array.isArray(rows) || rows.some(r => !canonicalRepo(r.full_name))) throw new Error("GitHub returned an invalid repository list.");
    repos.push(...rows.map(r => r.full_name));
    if (!response.headers.get("link")?.includes('rel="next"') && rows.length < 100) return [...new Set(repos)].sort();
    if (!response.headers.get("link")?.includes('rel="next"') && rows.length === 100) continue;
  }
  throw new Error("Repository listing exceeded 10,000 entries. No partial resync was saved.");
}
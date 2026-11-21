// Org-wide CODE scope: any OMERTA-ROW repository may be a CODE target, but the work always runs
// from the one passkey-pinned Jackboy workflow (central runner). Pure rules, tested.
export const CODE_ORG = "OMERTA-ROW";
export const CODE_RUNNER_REPO = `${CODE_ORG}/jackboy-dev-control`;
const ORG_REPO = /^OMERTA-ROW\/[A-Za-z0-9._-]{1,100}$/;

export type OrgRepoMeta = { fullName: string; archived: boolean; defaultBranch: string } | null;

export function isOrgRepo(repo: string): boolean {
  return ORG_REPO.test(repo) && !repo.endsWith("/.") && !repo.endsWith("/..");
}

/** Null when the repository may be a central CODE target; otherwise the plain reason it is refused. */
export function orgTargetRefusal(repo: string, meta: OrgRepoMeta, blocked: ReadonlySet<string>): string | null {
  if (!isOrgRepo(repo)) return `CODE refused ${repo}: only ${CODE_ORG} repositories are allowed.`;
  if (repo === CODE_RUNNER_REPO) return null; // Jackboy itself uses its own pin directly.
  if (blocked.has(repo)) return `CODE refused ${repo}: the owner blocked this repository.`;
  if (!meta) return `CODE refused ${repo}: Jackboy couldn't read this repository. Check the GitHub App and CODE token access.`;
  if (meta.fullName.toLowerCase() !== repo.toLowerCase()) return `CODE refused ${repo}: GitHub reports a different repository name.`;
  if (meta.archived) return `CODE refused ${repo}: the repository is archived.`;
  if (meta.defaultBranch !== "main") return `CODE refused ${repo}: its default branch isn't main.`;
  return null;
}

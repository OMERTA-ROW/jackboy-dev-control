// Pure rules for Jackboy's repository workspace. Tested in repo-workspace.test.ts.

export const WORK_BRANCH_PREFIX = "jackboy/";

/** Paths Jackboy may never write, even on a work branch. */
const BLOCKED = [/(^|\/)\.env(\.|$)/i, /(^|\/)\.git\//, /secret/i, /\.pem$/i, /\.key$/i, /^src\/integrations\/supabase\/(client|client\.server|types|auth-middleware|auth-attacher)\.ts$/];

export function checkPath(path: string): string | null {
  if (!path || path.length > 300) return "Path is empty or too long.";
  if (path.startsWith("/") || path.split("/").some((s) => s === ".." || s === "." || s === "")) return "Path must be relative with no '..' segments.";
  if (BLOCKED.some((r) => r.test(path))) return `Refused: "${path}" is a protected file (secrets, git internals or generated backend client).`;
  return null;
}

/** Writes are only allowed on Jackboy work branches, never the default/base branch. */
export function checkWorkBranch(branch: string, base: string): string | null {
  if (!branch.startsWith(WORK_BRANCH_PREFIX)) return `Refused: Jackboy only writes to branches starting with "${WORK_BRANCH_PREFIX}".`;
  if (branch === base) return "Refused: cannot write to the base branch.";
  if (!/^[A-Za-z0-9._/-]{3,100}$/.test(branch) || branch.includes("..")) return "Invalid branch name.";
  return null;
}

export function parseRepo(s: string | null | undefined): { owner: string; repo: string } | null {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec((s ?? "").trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export const MAX_WRITE_BYTES = 200_000;

export type RepoInfo = { full_name?: string; private: boolean; visibility?: string; archived?: boolean; owner?: { login: string; type: string }; permissions?: { pull?: boolean; push?: boolean; admin?: boolean; maintain?: boolean } };
export type RepoAccess = { canRead: boolean; canWrite: boolean; visibility: "public" | "private" | "internal"; org: string | null; reason: string | null };
/** Access comes only from the authenticated account's granted permissions; visibility never grants or denies write. */
export function assessRepoAccess(info: RepoInfo): RepoAccess {
  const visibility = (info.visibility === "internal" ? "internal" : info.private ? "private" : "public") as RepoAccess["visibility"];
  const org = info.owner?.type === "Organization" ? info.owner.login : null;
  const canRead = Boolean(info.permissions?.pull);
  const canWrite = canRead && Boolean(info.permissions?.push) && !info.archived;
  const reason = !canRead ? "The connected GitHub account has no read access to this repository."
    : info.archived ? "Repository is archived (read-only)."
    : !canWrite ? "The connected GitHub account can read but has no write (push) permission. Ask the repo/org admin to grant Contents: write and Pull requests: write." : null;
  return { canRead, canWrite, visibility, org, reason };
}

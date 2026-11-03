export type PermissionResult = { state: "verified" | "denied" | "unknown"; detail: string };
export type GithubPermissionEvidence = { repo: string; checkedAt: string; tokenAccount: string | null; workerCredential: string; exists: boolean; contentsRead: PermissionResult; pullRequestsWrite: PermissionResult; actionsRead: PermissionResult; actionsWrite: PermissionResult; tokenChecks: Record<string, PermissionResult> };
export function declaredPermission(value: string | undefined, name: string, repo: string): PermissionResult {
  return value === "write" ? { state: "verified", detail: `GitHub issued the App installation grant with ${name}: write on ${repo}; no job or PR was executed by this check.` } : value ? { state: "denied", detail: `${repo}: App grant has ${name}: ${value}, not write. Update the GitHub App permission and approve it for this installation.` } : { state: "unknown", detail: `${repo}: ${name}: write is not exposed for this token. Read success does not prove write; no write operation performed.` };
}
export function obsoleteGithubBlock(reason: string | null, evidence: GithubPermissionEvidence): boolean {
  if (!reason || !evidence.exists) return false;
  if (/pull requests?:?\s*write|draft pr refused/i.test(reason)) return evidence.contentsRead.state === "verified" && evidence.pullRequestsWrite.state === "verified";
  return false;
}
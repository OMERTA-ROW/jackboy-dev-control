// Pure helpers that turn GitHub API answers into a plain reason + fix link. No network, testable.
export const ORG = "OMERTA-ROW";
export const LINKS = {
  fineGrained: "https://github.com/settings/personal-access-tokens",
  classic: "https://github.com/settings/tokens",
  orgRequests: `https://github.com/organizations/${ORG}/settings/personal-access-token-requests`,
  orgPolicy: `https://github.com/organizations/${ORG}/settings/personal-access-tokens`,
} as const;

export type TokenKind = "fine-grained" | "classic" | "other";
export function tokenKind(token: string): TokenKind {
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("ghp_")) return "classic";
  return "other";
}

export type Reason = { reason: string; fixUrl: string };

/** Explain a failed GitHub call for a repo. */
export function explainFailure(status: number, message: string, repo: string, kind: TokenKind, op: "read" | "write"): Reason {
  const m = message.toLowerCase();
  const owner = repo.split("/")[0] ?? "";
  const tokenLink = kind === "classic" ? LINKS.classic : LINKS.fineGrained;
  if (status === 401) return { reason: "The token is invalid, revoked or expired.", fixUrl: tokenLink };
  if (m.includes("saml")) return { reason: `${owner} requires SAML single sign-on authorization for this token.`, fixUrl: LINKS.classic };
  if (m.includes("lifetime")) return { reason: `${owner} rejects tokens with this long a lifetime. Create one with a shorter expiry.`, fixUrl: tokenLink };
  if (m.includes("approv") || m.includes("pending")) return { reason: `${owner} has not approved this token yet. An org owner must approve the request.`, fixUrl: `https://github.com/organizations/${owner}/settings/personal-access-token-requests` };
  if (m.includes("forbids access via") || m.includes("fine-grained personal access tokens")) return { reason: `${owner} does not allow fine-grained tokens. An org owner must allow them.`, fixUrl: `https://github.com/organizations/${owner}/settings/personal-access-tokens` };
  if (m.includes("oauth app access restrictions")) return { reason: `${owner} restricts third-party access. An org owner must allow it.`, fixUrl: `https://github.com/organizations/${owner}/settings/oauth_application_policy` };
  if (m.includes("resource not accessible by personal access token")) {
    return op === "write"
      ? { reason: `The token can't write to ${repo}. ${kind === "fine-grained" ? `Add ${repo} to the token's repositories and set Contents: Read and write${owner === ORG ? `; ${ORG} must then approve the change` : ""}.` : "Give it the repo scope."}`, fixUrl: tokenLink }
      : { reason: `The token can't read ${repo}. Add it to the token's repositories with Contents: Read.`, fixUrl: tokenLink };
  }
  if (status === 404) return { reason: `${repo} is not visible to this token (not selected, private, or ${owner} hasn't approved it).`, fixUrl: tokenLink };
  if (status === 403 && m.includes("rate limit")) return { reason: "GitHub rate limit reached. Try again in a few minutes.", fixUrl: "https://github.com/settings/tokens" };
  return { reason: `GitHub said ${status}: ${message}`, fixUrl: tokenLink };
}

/** Pick the repos to check: known core repos plus accessible repos whose names match project keywords. */
export function pickRepos(known: string[], accessible: string[], keywords: string[]): string[] {
  const out = new Set(known);
  for (const r of accessible) if (keywords.some((k) => r.toLowerCase().includes(k))) out.add(r);
  return [...out].slice(0, 12);
}

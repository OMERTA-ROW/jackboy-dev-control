// Official provider authorization links for blocked capabilities (tested in provider-auth.test.ts).
// These only open the provider's own consent/settings pages. Jackboy never collects credentials;
// access counts only after a real verification call passes afterwards.

export type ProviderAuth = { provider: "GitHub"; permission: string; links: { label: string; url: string }[]; note: string; setupSteps: string[]; backendSetupUrl: string };

const REPO_RE = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;

export function parseRepo(repo: string | null | undefined): { owner: string; name: string } | null {
  const m = (repo ?? "").trim().match(REPO_RE);
  return m && m[1] && m[2] ? { owner: m[1], name: m[2] } : null;
}

/** Fine-grained token template URL; GitHub pre-fills the form, the owner still reviews and approves it. */
function tokenTemplate(owner: string, perms: Record<string, "read" | "write">, name: string) {
  const q = new URLSearchParams({ name, description: "Used only by Jackboy Dev Control", target_name: owner, expires_in: "90", ...perms });
  return `https://github.com/settings/personal-access-tokens/new?${q.toString()}`;
}

export function providerAuthFor(cap: string, repo: string | null | undefined): ProviderAuth | null {
  const r = parseRepo(repo);
  if (cap !== "github_repo" && cap !== "github_actions_read") return null;
  const perms: Record<string, "read" | "write"> = cap === "github_repo" ? { contents: "write", pull_requests: "write", metadata: "read" } : { actions: "read", metadata: "read" };
  const permission = cap === "github_repo"
    ? `Contents: Read & write and Pull requests: Read & write${r ? ` on ${r.owner}/${r.name}` : ""}`
    : `Actions: Read-only${r ? ` on ${r.owner}/${r.name}` : ""}`;
  const links = [
    { label: r ? `Create scoped GitHub key for ${r.owner}` : "Create scoped GitHub key", url: tokenTemplate(r?.owner ?? "", perms, cap === "github_repo" ? "Jackboy code access" : "Jackboy check results") },
    { label: "Edit existing GitHub key", url: "https://github.com/settings/personal-access-tokens" },
  ];
  if (r) links.push({ label: `Approve key requests in ${r.owner} (org admins)`, url: `https://github.com/organizations/${r.owner}/settings/personal-access-token-requests` });
  return {
    provider: "GitHub", permission, links,
    note: "Creating a key on GitHub does not install it in Jackboy or clear this blocker. Never paste the key into chat. Access clears only after approval and a successful connection check.",
    setupSteps: ["Create or update the GitHub key with only the repository and permissions shown above.", "Open the Jackboy project in Lovable and save the new key in backend Secrets as GITHUB_TOKEN. Saving it on GitHub alone is not enough.", "Return here and choose Approve with passkey & check. If already approved, choose Check again."],
    backendSetupUrl: "https://lovable.dev/projects/72823346-c174-4e90-9e17-671e197837c5",
  };
}


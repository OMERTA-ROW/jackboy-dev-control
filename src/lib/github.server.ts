import { assessRepoAccess, type RepoInfo } from "./repo-workspace";
// Server-only GitHub REST client. Token comes from the GITHUB_TOKEN backend secret; never returned to clients.
const API = "https://api.github.com";

export class GitHubError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export function githubConfigured() { return Boolean(process.env["GITHUB_TOKEN"]); }

async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { githubTokenFor, repoFromPath } = await import("./github-app.server");
  const token = (await githubTokenFor(repoFromPath(path)))?.token;
  if (!token) throw new GitHubError(401, "GitHub is not connected: install the Jackboy GitHub App or add the GITHUB_TOKEN secret.");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Jackboy", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    await (await import("./repository-resync.server")).invalidateRepositoryReview(res.status).catch(() => {});
    let msg = `GitHub ${res.status}`;
    try { msg = `GitHub ${res.status}: ${((await res.json()) as { message?: string }).message ?? ""}`; } catch { /* ignore */ }
    throw new GitHubError(res.status, msg);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

const r = (o: string, n: string) => `/repos/${encodeURIComponent(o)}/${encodeURIComponent(n)}`;

/** Refuses any repo (public or private) the connected account cannot write. Every write path calls this first. */
export async function requirePrivateRepo(owner: string, repo: string) {
  const info = await gh<RepoInfo & { default_branch: string }>(r(owner, repo));
  const a = assessRepoAccess(info);
  if (!a.canWrite) throw new GitHubError(403, `Refused: ${a.reason}`);
  return info;
}

export async function getTreePaths(owner: string, repo: string, branch: string): Promise<string[]> {
  const ref = await gh<{ object: { sha: string } }>(`${r(owner, repo)}/git/ref/heads/${encodeURIComponent(branch)}`);
  const t = await gh<{ tree: { path: string; type: string }[] }>(`${r(owner, repo)}/git/trees/${ref.object.sha}?recursive=1`);
  return t.tree.filter((x) => x.type === "blob").map((x) => x.path);
}

export async function readFile(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
  try {
    const f = await gh<{ content?: string; encoding?: string; size: number }>(`${r(owner, repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
    if (!f.content || f.encoding !== "base64" || f.size > 200_000) return null;
    const bin = atob(f.content.replace(/\n/g, ""));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch (e) { if (e instanceof GitHubError && e.status === 404) return null; throw e; }
}

type Change = { path: string; content: string | null }; // null = delete

/** Commits changes onto a new branch from `base` and returns the commit sha. Never touches the base branch. */
export async function commitToNewBranch(owner: string, repo: string, base: string, branch: string, message: string, changes: Change[]) {
  const ref = await gh<{ object: { sha: string } }>(`${r(owner, repo)}/git/ref/heads/${encodeURIComponent(base)}`);
  const baseCommit = await gh<{ tree: { sha: string } }>(`${r(owner, repo)}/git/commits/${ref.object.sha}`);
  const tree = await gh<{ sha: string }>(`${r(owner, repo)}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: changes.map((c) => ({ path: c.path, mode: "100644", type: "blob", ...(c.content === null ? { sha: null } : { content: c.content }) })) }),
  });
  const commit = await gh<{ sha: string }>(`${r(owner, repo)}/git/commits`, { method: "POST", body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }) });
  await gh(`${r(owner, repo)}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }) });
  return commit.sha;
}

export async function openPullRequest(owner: string, repo: string, head: string, base: string, title: string, body: string) {
  return gh<{ number: number; html_url: string }>(`${r(owner, repo)}/pulls`, { method: "POST", body: JSON.stringify({ title, head, base, body, draft: true }) });
}

export async function closePullRequest(owner: string, repo: string, n: number) {
  await gh(`${r(owner, repo)}/pulls/${n}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
}

export async function mergePullRequest(owner: string, repo: string, n: number, sha: string) {
  return gh<{ sha: string; merged: boolean }>(`${r(owner, repo)}/pulls/${n}/merge`, { method: "PUT", body: JSON.stringify({ merge_method: "squash", sha }) });
}

/** Combined GitHub Actions/check status for a commit: success | failure | pending | none. */
export async function checksState(owner: string, repo: string, sha: string): Promise<"success" | "failure" | "pending" | "none"> {
  const [runs, status] = await Promise.all([
    gh<{ check_runs: { status: string; conclusion: string | null }[] }>(`${r(owner, repo)}/commits/${sha}/check-runs?per_page=100`),
    gh<{ state: string; total_count: number }>(`${r(owner, repo)}/commits/${sha}/status`),
  ]);
  const all = runs.check_runs;
  if (!all.length && !status.total_count) return "none";
  if (all.some((c) => c.conclusion && ["failure", "timed_out", "cancelled", "action_required"].includes(c.conclusion)) || status.state === "failure" || status.state === "error") return "failure";
  if (all.some((c) => c.status !== "completed") || (status.total_count && status.state === "pending")) return "pending";
  if (all.some((c) => c.conclusion !== "success")) return "pending";
  return "success";
}

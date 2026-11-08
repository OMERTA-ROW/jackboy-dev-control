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

export async function openPullRequest(owner: string, repo: string, head: string, base: string, title: string, body: string, draft = true) {
  return gh<{ number: number; html_url: string; head: { sha: string } }>(`${r(owner, repo)}/pulls`, { method: "POST", body: JSON.stringify({ title, head, base, body, draft }) });
}

export type PullRequest = { number: number; html_url: string; state: "open" | "closed"; merged: boolean; draft: boolean; merge_commit_sha: string | null; head: { ref: string; sha: string }; base: { ref: string } };
export async function getPullRequest(owner: string, repo: string, n: number) {
  return gh<PullRequest>(`${r(owner, repo)}/pulls/${n}`);
}
/** The PR whose head is exactly this branch (any state), or null. */
export async function findPullByHead(owner: string, repo: string, branch: string): Promise<PullRequest | null> {
  const list = await gh<{ number: number }[]>(`${r(owner, repo)}/pulls?state=all&per_page=5&head=${encodeURIComponent(`${owner}:${branch}`)}`);
  return list[0] ? getPullRequest(owner, repo, list[0].number) : null;
}
export async function listPullFiles(owner: string, repo: string, n: number) {
  return gh<{ filename: string; status: string; previous_filename?: string }[]>(`${r(owner, repo)}/pulls/${n}/files?per_page=100`);
}
export async function getCommitParents(owner: string, repo: string, sha: string): Promise<string[]> {
  const c = await gh<{ parents: { sha: string }[] }>(`${r(owner, repo)}/commits/${encodeURIComponent(sha)}`);
  return c.parents.map((p) => p.sha);
}
/** Git blob id of a file at a ref, or null when the file doesn't exist there. */
export async function fileBlobSha(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
  try {
    const f = await gh<{ sha: string; type: string }>(`${r(owner, repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
    return f.type === "file" ? f.sha : null;
  } catch (e) { if (e instanceof GitHubError && e.status === 404) return null; throw e; }
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

// ---- Read helpers for issue/PR preparation (github-prep.server.ts). No merge or deploy here. ----
export async function commitShaForRef(owner: string, repo: string, ref: string): Promise<string> {
  const c = await gh<{ sha: string }>(`${r(owner, repo)}/commits/${encodeURIComponent(ref)}`);
  return c.sha;
}
export async function listCheckRuns(owner: string, repo: string, sha: string) {
  const x = await gh<{ check_runs: { name: string; status: string; conclusion: string | null; html_url: string | null }[] }>(
    `${r(owner, repo)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
  );
  return x.check_runs;
}
export async function listCommitStatuses(owner: string, repo: string, sha: string) {
  return gh<{ context: string; state: string; target_url: string | null }[]>(
    `${r(owner, repo)}/commits/${encodeURIComponent(sha)}/statuses?per_page=100`,
  );
}
export type OpenPull = {
  number: number; title: string; html_url: string; draft: boolean; user: { login: string } | null;
  head: { ref: string; sha: string }; base: { ref: string }; updated_at: string;
  requested_reviewers: { login: string }[]; requested_teams: { slug: string }[];
};
export async function listOpenPulls(owner: string, repo: string, limit = 10) {
  return gh<OpenPull[]>(`${r(owner, repo)}/pulls?state=open&sort=updated&direction=desc&per_page=${Math.min(30, limit)}`);
}
export async function listPullReviews(owner: string, repo: string, n: number) {
  return gh<{ user: { login: string } | null; state: string; submitted_at: string | null }[]>(
    `${r(owner, repo)}/pulls/${n}/reviews?per_page=100`,
  );
}
export async function branchExists(owner: string, repo: string, branch: string): Promise<boolean> {
  try {
    await gh(`${r(owner, repo)}/git/ref/heads/${encodeURIComponent(branch)}`);
    return true;
  } catch (e) { if (e instanceof GitHubError && e.status === 404) return false; throw e; }
}
/** Creates one issue. Callers must have checked write access with requirePrivateRepo first. */
export async function createIssue(owner: string, repo: string, title: string, body: string) {
  return gh<{ number: number; html_url: string }>(`${r(owner, repo)}/issues`, { method: "POST", body: JSON.stringify({ title, body }) });
}

// Server-only repository workspace: tree/search/read/write on jackboy/* branches, diff, draft PR, CI checks.
// Uses the GITHUB_TOKEN secret; every call re-verifies the repo is private and the token can push.
import { checkPath, checkWorkBranch, MAX_WRITE_BYTES, parseRepo } from "./repo-workspace";

const API = "https://api.github.com";

async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GitHub is not connected: GITHUB_TOKEN secret is missing.");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Jackboy", ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const b64 = (s: string) => { const b = new TextEncoder().encode(s); let o = ""; for (let i = 0; i < b.length; i += 0x8000) o += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(o); };
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

export type Repo = { owner: string; repo: string; base: string; full: string };

/** Resolves and authorizes a repo: must parse, be private and allow push. */
export async function openRepo(full: string): Promise<Repo> {
  const r = parseRepo(full);
  if (!r) throw new Error(`"${full}" is not an owner/repo name.`);
  const info = await gh<{ private: boolean; default_branch: string; permissions?: { push?: boolean } }>(`/repos/${r.owner}/${r.repo}`);
  if (!info.private) throw new Error(`Refused: ${full} is public. Jackboy only works in private repositories.`);
  if (!info.permissions?.push) throw new Error(`The GitHub token cannot push to ${full}.`);
  return { ...r, base: info.default_branch, full };
}
const R = (x: Repo) => `/repos/${x.owner}/${x.repo}`;

export async function listAccessibleRepos() {
  const d = await gh<{ full_name: string; private: boolean; permissions?: { push?: boolean }; default_branch: string }[]>("/user/repos?per_page=100&sort=updated");
  return d.map((r) => ({ repo: r.full_name, private: r.private, canPush: Boolean(r.permissions?.push), usable: r.private && Boolean(r.permissions?.push) }));
}

export async function tree(x: Repo, ref: string, filter?: string | null) {
  const c = await gh<{ commit: { tree: { sha: string } } }>(`${R(x)}/commits/${encodeURIComponent(ref)}`);
  const t = await gh<{ tree: { path: string; type: string; size?: number }[]; truncated: boolean }>(`${R(x)}/git/trees/${c.commit.tree.sha}?recursive=1`);
  const f = filter?.toLowerCase();
  const files = t.tree.filter((e) => e.type === "blob" && !e.path.startsWith("node_modules/") && (!f || e.path.toLowerCase().includes(f))).map((e) => e.path);
  return { total: files.length, files: files.slice(0, 400), truncated: t.truncated || files.length > 400 };
}

export async function search(x: Repo, query: string) {
  const q = encodeURIComponent(`${query} repo:${x.owner}/${x.repo}`);
  const d = await gh<{ total_count: number; items: { path: string }[] }>(`/search/code?q=${q}&per_page=30`);
  return { note: "GitHub code search covers the default branch only.", total: d.total_count, paths: d.items.map((i) => i.path) };
}

export async function read(x: Repo, path: string, ref: string) {
  if (/(^|\/)\.env|\.pem$|\.key$/i.test(path)) throw new Error("Refused: secret/environment files are never read.");
  const bad = checkPath(path); // generated backend files may be read but not written
  if (bad && !bad.startsWith("Refused")) throw new Error(bad);
  const f = await gh<{ content?: string; encoding?: string; size: number; sha: string }>(`${R(x)}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`);
  if (!f.content || f.encoding !== "base64") throw new Error("Not a readable file.");
  if (f.size > MAX_WRITE_BYTES) throw new Error("File too large to read (over 200 KB).");
  return { path, ref, sha: f.sha, content: unb64(f.content) };
}

async function ensureBranch(x: Repo, branch: string) {
  try { await gh(`${R(x)}/git/ref/heads/${enc(branch)}`); return false; }
  catch (e) {
    if (!String(e).includes("404")) throw e;
    const base = await gh<{ object: { sha: string } }>(`${R(x)}/git/ref/heads/${enc(x.base)}`);
    await gh(`${R(x)}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }) });
    return true;
  }
}

/** Creates or replaces (content) or deletes (null) a file on a jackboy/* branch. */
export async function write(x: Repo, branch: string, path: string, content: string | null, message: string) {
  const be = checkWorkBranch(branch, x.base); if (be) throw new Error(be);
  const pe = checkPath(path); if (pe) throw new Error(pe);
  if (content !== null && new TextEncoder().encode(content).length > MAX_WRITE_BYTES) throw new Error("Content over 200 KB.");
  const created = await ensureBranch(x, branch);
  let sha: string | undefined;
  try { sha = (await gh<{ sha: string }>(`${R(x)}/contents/${enc(path)}?ref=${encodeURIComponent(branch)}`)).sha; } catch (e) { if (!String(e).includes("404")) throw e; }
  const msg = `${message.slice(0, 200)}\n\nWritten by Jackboy`;
  if (content === null) {
    if (!sha) throw new Error("File does not exist on that branch.");
    const r = await gh<{ commit: { sha: string } }>(`${R(x)}/contents/${enc(path)}`, { method: "DELETE", body: JSON.stringify({ message: msg, sha, branch }) });
    return { branch, branchCreated: created, path, action: "deleted", commit: r.commit.sha };
  }
  const r = await gh<{ commit: { sha: string } }>(`${R(x)}/contents/${enc(path)}`, { method: "PUT", body: JSON.stringify({ message: msg, content: b64(content), branch, ...(sha ? { sha } : {}) }) });
  return { branch, branchCreated: created, path, action: sha ? "updated" : "created", commit: r.commit.sha };
}

export async function diff(x: Repo, branch: string) {
  const d = await gh<{ ahead_by: number; files?: { filename: string; status: string; additions: number; deletions: number; patch?: string }[] }>(`${R(x)}/compare/${enc(x.base)}...${enc(branch)}`);
  return { base: x.base, branch, commitsAhead: d.ahead_by, files: (d.files ?? []).map((f) => ({ file: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: (f.patch ?? "").slice(0, 6000) })) };
}

/** Opens a DRAFT pull request. Jackboy never merges; the owner merges on GitHub or via Approvals. */
export async function openDraftPr(x: Repo, branch: string, title: string, body: string) {
  const be = checkWorkBranch(branch, x.base); if (be) throw new Error(be);
  const existing = await gh<{ number: number; html_url: string }[]>(`${R(x)}/pulls?head=${encodeURIComponent(`${x.owner}:${branch}`)}&state=open`);
  if (existing[0]) return { number: existing[0].number, url: existing[0].html_url, existed: true };
  const pr = await gh<{ number: number; html_url: string }>(`${R(x)}/pulls`, { method: "POST", body: JSON.stringify({ title: title.slice(0, 200), head: branch, base: x.base, body: `${body.slice(0, 4000)}\n\n_Opened by Jackboy as a draft. Owner review required; Jackboy does not merge._`, draft: true }) });
  return { number: pr.number, url: pr.html_url, existed: false };
}

export async function checks(x: Repo, ref: string) {
  const [runs, wf] = await Promise.all([
    gh<{ check_runs: { name: string; status: string; conclusion: string | null; html_url: string }[] }>(`${R(x)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=50`),
    gh<{ total_count: number }>(`${R(x)}/actions/workflows`).catch(() => ({ total_count: 0 })),
  ]);
  return {
    workflowsConfigured: wf.total_count,
    runs: runs.check_runs.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url })),
    note: wf.total_count ? undefined : "This repository has no GitHub Actions workflows, so no automated checks run. A checks workflow must be added (via an owner-approved PR) first.",
  };
}

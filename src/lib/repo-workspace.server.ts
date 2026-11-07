import { checkWorkflowContent, isWorkflowPath } from "./guidelines";
// Server-only repository workspace: tree/search/read/write on jackboy/* branches, diff, draft PR, CI checks.
// Uses the GITHUB_TOKEN secret; every call re-verifies the account has read+push permission (public or private).
import { assessRepoAccess, checkPath, checkWorkBranch, MAX_WRITE_BYTES, parseRepo, type RepoInfo } from "./repo-workspace";

const API = "https://api.github.com";

async function gh<T>(path: string, init: RequestInit = {}, tokenOverride?: string): Promise<T> {
  const { githubTokenFor, repoFromPath } = await import("./github-app.server");
  const token = tokenOverride ?? (await githubTokenFor(repoFromPath(path)))?.token;
  if (!token) throw new Error("GitHub is not connected: install the Jackboy GitHub App or add the GITHUB_TOKEN secret.");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Jackboy", ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (!res.ok) {
    await (await import("./repository-resync.server")).invalidateRepositoryReview(res.status).catch(() => {});
    throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
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
  const info = await gh<RepoInfo & { default_branch: string }>(`/repos/${r.owner}/${r.repo}`);
  const { githubTokenFor, appAccessFor } = await import("./github-app.server");
  if ((await githubTokenFor(full))?.via === "app") {
    const acc = await appAccessFor(full);
    if (!acc) throw new Error(`Refused for ${full}: the Jackboy GitHub App is not installed on this repository.`);
    if (!acc.canWrite) throw new Error(`Refused for ${full}: the Jackboy GitHub App installation lacks Contents: write.`);
  } else {
    const a = assessRepoAccess(info);
    if (!a.canWrite) throw new Error(`Refused for ${full}: ${a.reason}`);
  }
  return { ...r, base: info.default_branch, full };
}
const R = (x: Repo) => `/repos/${x.owner}/${x.repo}`;

export async function listAccessibleRepos() {
  type Row = { repo: string; private: boolean; visibility: string; org: string | null; canPush: boolean; usable: boolean };
  const out: Row[] = [];
  let tokenError: Error | null = null;
  if (process.env["GITHUB_TOKEN"]) {
    try {
      const d = await gh<(RepoInfo & { full_name: string })[]>("/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member");
      out.push(...d.map((r) => { const a = assessRepoAccess(r); return { repo: r.full_name, private: r.private, visibility: a.visibility, org: a.org, canPush: a.canWrite, usable: a.canWrite }; }));
    } catch (e) { tokenError = e as Error; }
  }
  // GitHub App installations: write comes from the installation's granted permissions, not the repo's user-style flags.
  const app = await import("./github-app.server");
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await app.syncInstallations(null).catch(() => []);
  const { data: installs } = await supabaseAdmin.from("github_installations").select("account_login,account_type,repositories,permissions").eq("revoked", false);
  for (const i of installs ?? []) {
    const perms = (i.permissions ?? {}) as Record<string, string>;
    const write = perms["contents"] === "write" && perms["pull_requests"] === "write";
    for (const repo of (i.repositories as string[] | null) ?? []) {
      const idx = out.findIndex((r) => r.repo.toLowerCase() === repo.toLowerCase());
      const row = { repo, private: true, visibility: "private", org: i.account_type === "Organization" ? String(i.account_login) : null, canPush: write, usable: write };
      if (idx >= 0) { const cur = out[idx]!; out[idx] = { ...cur, canPush: cur.canPush || write, usable: cur.usable || write }; } else out.push(row);
    }
  }
  if (!out.length && tokenError) throw tokenError;
  return out;
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
  if (content !== null && isWorkflowPath(path)) { const we = checkWorkflowContent(content); if (we) throw new Error(we); }
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
  const check = await checks(x, branch);
  const { existingTestsPassed } = await import("./work-policy");
  const head = await gh<{ object: { sha: string } }>(`${R(x)}/git/ref/heads/${branch.split("/").map(enc).join("/")}`);
  const currentRuns = check.runs.filter((r) => r.headSha === head.object.sha);
  if (!existingTestsPassed(currentRuns, check.workflowsConfigured, "error" in check ? check.error : undefined)) throw new Error(`Draft PR blocked on ${x.full}, branch ${branch}: existing tests must finish successfully for current commit ${head.object.sha}. ${"error" in check && check.error ? check.error : check.workflowsConfigured === 0 ? "No test workflow or isolated runner is connected." : "Checks are absent, pending or failed."} Branch preserved; no PR opened.`);
  const { githubTokenFor, appAccessFor } = await import("./github-app.server");
  if ((await githubTokenFor(x.full))?.via === "app") {
    const access = await appAccessFor(x.full);
    if (!access) {
      throw new Error(`Draft PR refused: the Jackboy GitHub App installation could not be verified for ${x.full}. Branch ${branch} is unchanged and preserved.`);
    }
    if (!access.canCreatePullRequests) {
      throw new Error(`Draft PR refused: GitHub App installation lacks Pull requests: write on ${x.full}. Branch ${branch} was already pushed and remains unchanged. Update and approve the app permission, then verify the installation in Jackboy.`);
    }
  }
  let pr: { number: number; html_url: string };
  const payload = JSON.stringify({ title: title.slice(0, 200), head: branch, base: x.base, body: `${body.slice(0, 4000)}\n\n_Opened by Jackboy as a draft. Owner review required; Jackboy does not merge._`, draft: true });
  try {
    pr = await gh<{ number: number; html_url: string }>(`${R(x)}/pulls`, { method: "POST", body: payload });
  } catch (error) {
    if (/GitHub 403:.*(?:resource not accessible|pull requests?: write|permission.*pull request)/i.test((error as Error).message)) {
      try {
        const { refreshGithubTokenFor } = await import("./github-app.server");
        const fresh = await refreshGithubTokenFor(x.full);
        if (fresh?.via === "app") {
          pr = await gh<{ number: number; html_url: string }>(`${R(x)}/pulls`, { method: "POST", body: payload }, fresh.token);
          return { number: pr.number, url: pr.html_url, existed: false };
        }
      } catch {
        // The permission denial below remains the actionable failure; no branch operation is retried.
      }
      throw new Error(`Draft PR refused: GitHub denied Pull requests: write on ${x.full}. Branch ${branch} was already pushed and remains unchanged. Verify the Jackboy GitHub App permission and its installation grant for this repository.`);
    }
    throw error;
  }
  return { number: pr.number, url: pr.html_url, existed: false };
}

async function ghWithAppTokenRefresh<T>(x: Repo, path: string): Promise<T> {
  try {
    return await gh<T>(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/^GitHub 403:/.test(message)) throw error;
    const { refreshGithubTokenFor } = await import("./github-app.server");
    const fresh = await refreshGithubTokenFor(x.full);
    if (fresh?.via !== "app") throw error;
    return gh<T>(path, {}, fresh.token);
  }
}

export async function checks(x: Repo, ref: string) {
  const wf = await ghWithAppTokenRefresh<{ total_count: number }>(
    x,
    `${R(x)}/actions/workflows`,
  ).catch((e) => ({ total_count: -1, error: String(e) }));
  if (wf.total_count === 0) return { workflowsConfigured: 0, runs: [], note: "This repository has no GitHub Actions workflows, so no automated checks run yet." };
  try {
    const d = await ghWithAppTokenRefresh<{
      workflow_runs: {
        name: string;
        status: string;
        conclusion: string | null;
        html_url: string;
        head_sha: string;
        head_branch: string;
      }[];
    }>(
      x,
      `${R(x)}/actions/runs?branch=${encodeURIComponent(ref)}&per_page=10`,
    );
    return { workflowsConfigured: wf.total_count, runs: d.workflow_runs.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, commit: r.head_sha.slice(0, 7), headSha: r.head_sha, url: r.html_url })) };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e);
    const message = errorMessage.slice(0, 160);
    const permissionGuidance = /^GitHub 403:/.test(errorMessage)
      ? ' Verify the Jackboy App installation grants "Actions: read".'
      : "";
    return {
      workflowsConfigured: wf.total_count,
      runs: [],
      error: `Cannot read check results: ${message}.${permissionGuidance}`,
    };
  }
}

/** Read-only GET under one repository with the workspace credential (App installation or GITHUB_TOKEN). */
export async function repoGet<T>(x: Repo, path: string): Promise<T> {
  return gh<T>(`${R(x)}${path}`);
}

/** Blob SHA of one file at a ref, or null when the file or ref doesn't exist. */
export async function fileSha(x: Repo, path: string, ref: string): Promise<string | null> {
  try {
    const f = await gh<{ sha?: string; type?: string }>(`${R(x)}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`);
    return f.type === "file" && typeof f.sha === "string" ? f.sha : null;
  } catch (e) {
    if (String(e).includes("GitHub 404")) return null;
    throw e;
  }
}

/** CODE onboarding only: opens a DRAFT PR whose diff is exactly the owner-approved files (path + blob SHA), nothing else.
 * Replaces the "existing checks passed" gate used for code changes, which cannot apply before the CODE workflow exists. */
export async function openExactDraftPr(x: Repo, branch: string, title: string, body: string, expected: { path: string; sha: string }[]) {
  const be = checkWorkBranch(branch, x.base); if (be) throw new Error(be);
  if (!expected.length) throw new Error("Nothing to propose: the approved files are already on the main branch.");
  const d = await gh<{ files?: { filename: string; sha: string; status: string }[] }>(`${R(x)}/compare/${enc(x.base)}...${enc(branch)}`);
  const files = d.files ?? [];
  const want = new Map(expected.map((f) => [f.path, f.sha]));
  const extra = files.filter((f) => want.get(f.filename) !== f.sha || f.status === "removed");
  const missing = expected.filter((f) => !files.some((g) => g.filename === f.path && g.sha === f.sha));
  if (extra.length || missing.length) {
    throw new Error(`Draft PR refused on ${x.full}: branch ${branch} must change exactly the approved CODE files. ${extra.length ? `Unexpected: ${extra.map((f) => f.filename).join(", ")}. ` : ""}${missing.length ? `Missing or different: ${missing.map((f) => f.path).join(", ")}.` : ""} Branch preserved; no PR opened.`);
  }
  const existing = await gh<{ number: number; html_url: string }[]>(`${R(x)}/pulls?head=${encodeURIComponent(`${x.owner}:${branch}`)}&state=open`);
  if (existing[0]) return { number: existing[0].number, url: existing[0].html_url, existed: true };
  const payload = JSON.stringify({ title: title.slice(0, 200), head: branch, base: x.base, body: `${body.slice(0, 4000)}\n\n_Opened by Jackboy as a draft. Owner review required; Jackboy does not merge._`, draft: true });
  const pr = await gh<{ number: number; html_url: string }>(`${R(x)}/pulls`, { method: "POST", body: payload });
  return { number: pr.number, url: pr.html_url, existed: false };
}

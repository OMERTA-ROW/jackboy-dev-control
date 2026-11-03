import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildRepositoryReview, normalizeRepo, projectRepoMatch, tokenOwnerWarning, type RepoCandidate, type RepositoryReference, type RepositoryCheck, type RepositoryProfileChange } from "./repository-resync";

/** Invalidate read-only evidence after GitHub failures; never changes project references or grants. */
export async function invalidateRepositoryReview(status: number) {
  if (status !== 403 && status !== 404) return;
  await supabaseAdmin.from("repository_resync_reviews").update({ invalidated: true }).eq("invalidated", false).is("approved_at", null);
}
export async function repositoryDriftStatuses(userId: string): Promise<Record<string, string>> {
  const { data } = await supabaseAdmin.from("repository_resync_reviews").select("report,invalidated").eq("requested_by", userId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  const rows = (data?.report as unknown as { rows?: { repo: string; group: string }[] } | null)?.rows ?? [];
  return Object.fromEntries(rows.map((r) => [r.repo.toLowerCase(), data?.invalidated ? "needs_review" : r.group]));
}
export async function scanRepositories(userId: string) {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN is missing. Add it in Project Settings → Secrets.");
  const gh = (path: string) => fetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Jackboy" }, signal: AbortSignal.timeout(15000) });
  const me = await gh("/user");
  if (!me.ok) throw new Error(`GITHUB_TOKEN verification failed (${me.status}); update it in Project Settings → Secrets.`);
  const { login } = await me.json() as { login: string };
  const scopes = me.headers.get("x-oauth-scopes")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
  const inventory: string[] = [];
  const candidates: RepoCandidate[] = [];
  // Complete pagination or fail closed: never derive removals from a partial listing.
  for (let page = 1; ; page++) {
    if (page > 50) throw new Error("GitHub inventory exceeds the scan limit; no removal review was created.");
    const res = await gh(`/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`);
    if (!res.ok) throw new Error(`Cannot list all repositories (${res.status}); no removal review was created.`);
    const repos = await res.json() as RepoCandidate[];
    candidates.push(...repos);
    inventory.push(...repos.map((r) => r.full_name));
    if (repos.length < 100) break;
  }
  const { data, error } = await supabaseAdmin.rpc("repository_reference_inventory");
  if (error) throw new Error(error.message);
  const refs = (data ?? []) as unknown as RepositoryReference[];
  const saved = [...new Set(refs.map((r) => normalizeRepo(r.value)))];
  const checks: Record<string, RepositoryCheck> = {};
  const permissions = { contents: "Unknown — GitHub does not enumerate fine-grained permissions", pull_requests: "Unknown — read does not prove write", actions: "Unknown", workflows: "Unknown — workflow read does not prove write" };
  if (scopes.includes("repo")) { permissions.contents = "Read/write scope (subject to repository access)"; permissions.pull_requests = "Read/write scope (subject to repository access)"; permissions.actions = "Read scope (subject to repository access)"; }
  if (scopes.includes("workflow")) permissions.workflows = "Write scope (subject to repository access)";
  for (let i = 0; i < saved.length; i += 4) {
    await Promise.all(saved.slice(i, i + 4).map(async (repo) => {
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { checks[repo] = { status: 0, reason: "Invalid saved repository reference; manual review required" }; return; }
      try {
        const res = await gh(`/repos/${repo}`);
        const body = await res.json() as { full_name?: string; message?: string };
        checks[repo] = { status: res.status, ...(body.full_name ? { canonical: body.full_name } : {}), reason: res.ok ? "Accessible" : `GitHub ${res.status}: ${body.message ?? res.statusText}` };
      } catch { checks[repo] = { status: 0, reason: "GitHub timed out; removal blocked until verification succeeds" }; }
    }));
  }
  const probe = inventory[0];
  if (probe && scopes.length === 0) {
    for (const [name, path] of [["contents", "contents"], ["pull_requests", "pulls?per_page=1"], ["actions", "actions/runs?per_page=1"]] as const) {
      try { const r = await gh(`/repos/${probe}/${path}`); permissions[name] = r.ok ? `Read verified on ${probe}; write unknown` : `Read denied on ${probe} (${r.status}); write unknown`; } catch { permissions[name] = "Verification timed out"; }
    }
  }
  const rows = buildRepositoryReview(refs, inventory, checks);
  const [profiles, agents] = await Promise.all([
    supabaseAdmin.from("owner_projects").select("id,name,github_repo,lovable_url"),
    supabaseAdmin.from("agent_projects").select("id,name,repo_url,lovable_project_ref"),
  ]);
  if (profiles.error || agents.error) throw new Error(profiles.error?.message ?? agents.error?.message);
  for (const p of profiles.data ?? []) {
    const row = p.github_repo ? rows.find((r) => r.repo.toLowerCase() === normalizeRepo(p.github_repo ?? "").toLowerCase()) : null;
    const proposed = p.github_repo ? row?.proposed : projectRepoMatch(p.name, p.lovable_url, candidates);
    const agentProfiles = (agents.data ?? []).filter((a) => (a.lovable_project_ref && p.lovable_url?.includes(a.lovable_project_ref)) || a.name.toLowerCase() === p.name.toLowerCase()).map(({ id, name, repo_url }) => ({ id, name, repo_url }));
    const profile: RepositoryProfileChange | null = proposed ? { projectId: p.id, oldName: p.name, oldRepo: p.github_repo, newName: proposed.split("/").pop() ?? p.name, agentProfiles } : null;
    if (!p.github_repo) rows.push({ repo: `project:${p.id}`, proposed: proposed ?? null, group: "missing", reason: proposed ? "Proposed from token-visible repository name or Lovable link; confirm this is the same project." : "No unique token-visible match; no change proposed.", mutable: 1, historical: 0, canApply: Boolean(proposed), profiles: profile ? [profile] : [{ projectId: p.id, oldName: p.name, oldRepo: null, newName: p.name, agentProfiles }] });
    else if (row && profile) row.profiles = [...(row.profiles ?? []), profile];
  }
  // Approval-bound or running work must stay targeted at its original repo.
  const [tasks, proposals, jobs, approvals] = await Promise.all([
    supabaseAdmin.from("foundry_tasks").select("project_id,state,branch,commit_sha,pr_number,approved_action").not("state", "in", "(completed,failed,rolled_back,rejected)"),
    supabaseAdmin.from("update_proposals").select("project_id").not("status", "in", "(rejected,merged,reverted)"),
    supabaseAdmin.from("omni_jobs").select("project_id,status,code_request_id").in("status", ["queued", "sent", "running"]),
    supabaseAdmin.from("action_requests").select("project_id").in("status", ["pending", "approved", "executing"]),
  ]);
  for (const r of [tasks, proposals, jobs, approvals]) if (r.error) throw new Error(r.error.message);
  const protectedProjects = new Set([
    ...(proposals.data ?? []).map((r) => r.project_id), ...(approvals.data ?? []).map((r) => r.project_id),
    ...(tasks.data ?? []).filter((r) => r.branch || r.commit_sha || r.pr_number || r.approved_action || !["discovered", "blocked"].includes(r.state)).map((r) => r.project_id),
    ...(jobs.data ?? []).filter((r) => r.status !== "queued" || r.code_request_id).map((r) => r.project_id),
  ]);
  for (const row of rows) if (row.profiles?.some((p) => protectedProjects.has(p.projectId)) || refs.some((r) => r.table === "owner_projects" && normalizeRepo(r.value).toLowerCase() === row.repo.toLowerCase() && protectedProjects.has(r.id))) {
    row.canApply = false; if (row.group !== "linked") row.reason += " Approval-bound or running work exists: resolve it before changing this target.";
  }
  const report = { login, scopes, permissions, warning: tokenOwnerWarning(login, saved), rows, inventoryCount: inventory.length };
  const inserted = await supabaseAdmin.from("repository_resync_reviews").insert({ requested_by: userId, inventory, references_snapshot: refs as never, report: report as never }).select("id,created_at,expires_at,approved_at,report,invalidated").single();
  if (inserted.error) throw new Error(inserted.error.message);
  return inserted.data;
}
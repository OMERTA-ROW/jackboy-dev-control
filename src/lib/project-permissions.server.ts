import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { declaredPermission, obsoleteGithubBlock, type GithubPermissionEvidence, type PermissionResult } from "./project-permissions";
import { githubTokenFor, refreshGithubTokenFor, syncInstallations, appAccessFor } from "./github-app.server";

export async function checkProjectPermissions(projectId: string, actor: string): Promise<GithubPermissionEvidence> {
  const p = await supabaseAdmin.from("owner_projects").select("github_repo").eq("id", projectId).single();
  if (p.error || !p.data.github_repo) throw new Error("Link a repository first; review missing links in Settings → Repository review.");
  const repo = p.data.github_repo;
  const request = async (token: string | undefined, path: string): Promise<Response | null> => token ? fetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Jackboy", "X-GitHub-Api-Version": "2022-11-28" }, signal: AbortSignal.timeout(10000) }).catch(() => null) : null;
  const result = (r: Response | null, label: string): PermissionResult => ({ state: r?.ok ? "verified" : r ? "denied" : "unknown", detail: r?.ok ? `${repo}: ${label} verified by live GET` : r ? `${repo}: ${label} returned HTTP ${r.status}. Check selected repository, organization approval and ${label} permission on GitHub.` : `${repo}: ${label} could not be checked (credential missing or network timeout)` });
  const token = process.env["GITHUB_TOKEN"];
  const me = await request(token, "/user");
  const tokenAccount = me?.ok ? ((await me.json()) as { login: string }).login : null;
  const [tr, tc, ta, tp] = await Promise.all([request(token, `/repos/${repo}`), request(token, `/repos/${repo}/contents`), request(token, `/repos/${repo}/actions/runs?per_page=1`), request(token, `/repos/${repo}/pulls?per_page=1`)]);
  const tokenChecks = { contentsRead: result(tc, "Contents: read"), pullRequestsRead: result(tp, "Pull requests: read"), actionsRead: result(ta, "Actions: read"),
    pullRequestsWrite: declaredPermission(undefined, "Pull requests", repo), actionsWrite: declaredPermission(undefined, "Actions", repo) };
  let auth = await githubTokenFor(repo);
  if (auth?.via === "app") { await syncInstallations(null); auth = await refreshGithubTokenFor(repo); }
  const [rr, cr, ar] = await Promise.all([request(auth?.token, `/repos/${repo}`), request(auth?.token, `/repos/${repo}/contents`), request(auth?.token, `/repos/${repo}/actions/runs?per_page=1`)]);
  const access = auth?.via === "app" ? await appAccessFor(repo) : null;
  const evidence: GithubPermissionEvidence = { repo, checkedAt: new Date().toISOString(), tokenAccount, workerCredential: auth?.via === "app" ? "Jackboy GitHub App" : auth ? "GITHUB_TOKEN" : "No authorized credential", exists: !!rr?.ok,
    contentsRead: result(cr, "Contents: read"), actionsRead: result(ar, "Actions: read"), pullRequestsWrite: access ? declaredPermission(access.permissions["pull_requests"], "Pull requests", repo) : tokenChecks.pullRequestsWrite, actionsWrite: access ? declaredPermission(access.permissions["actions"], "Actions", repo) : tokenChecks.actionsWrite, tokenChecks };
  const saved = await supabaseAdmin.from("project_github_checks").upsert({ project_id: projectId, repo, checked_at: evidence.checkedAt, evidence: evidence as never });
  if (saved.error) throw new Error(saved.error.message);
  const tasks = await supabaseAdmin.from("foundry_tasks").select("id,state,blocked_reason").eq("project_id", projectId).eq("repo", repo).eq("state", "blocked");
  for (const t of tasks.data ?? []) if (t.blocked_reason && obsoleteGithubBlock(t.blocked_reason, evidence)) {
    const note = "Previous Pull requests permission error cleared by fresh GitHub verification. Job remains blocked for review; no retry or dispatch performed.";
    await supabaseAdmin.from("foundry_tasks").update({ blocked_reason: note, updated_at: evidence.checkedAt }).eq("id", t.id).eq("blocked_reason", t.blocked_reason);
    await supabaseAdmin.from("foundry_events").insert({ task_id: t.id, project_id: projectId, actor, action: "permission_reverified", from_state: t.state, to_state: t.state, note });
  }
  const { logSite } = await import("./site-log.server");
  await logSite({ actor, action: "github.permissions.checked", category: "config", status: evidence.exists ? "ok" : "blocked", project_id: projectId, repo, summary: `${repo}: live permissions checked; work uses ${evidence.workerCredential}. PR write ${evidence.pullRequestsWrite.state}, Actions read ${evidence.actionsRead.state}, Actions write ${evidence.actionsWrite.state}. No jobs executed.` });
  if (rr?.status === 404 || tr?.status === 404) await (await import("./repository-resync.server")).invalidateRepositoryReview(404);
  return evidence;
}
// Server-only runtime for "Add project to CODE". Reads are read-only; the only writes are files on the
// jackboy/code-onboarding branch, one draft PR, and (after a fresh passkey) set_code_site_pin.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { untyped } from "./untyped-db";
import * as ws from "./repo-workspace.server";
import { profileFiles } from "./code-profiles.server";
import { parseCodeTargets, type CodeTarget } from "./code-safety";
import {
  activationBlockReason, ANCHOR_REPO, buildChecklist, CODE_RUNNER_ORIGIN, codeTargetsWithout, detectProfile,
  nextCodeTargetsValue, ONBOARD_BRANCH, PROFILE_LABEL, PROFILE_PATHS, sitePhase, type EnvState, type ProfileFile, type SiteFacts,
} from "./code-onboarding";

const API = "https://api.github.com";

/** GET with the separate run-starting credential (CODE_GITHUB_TOKEN). Returns the HTTP status and body; never throws on 4xx. */
async function codeGh<T>(path: string): Promise<{ status: number; body: T | null }> {
  const token = process.env["CODE_GITHUB_TOKEN"];
  if (!token) return { status: 0, body: null };
  const headers = new Headers({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Jackboy" });
  headers.set("Authorization", ["Bearer", token].join(" "));
  const res = await fetch(`${API}${path}`, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) });
  return { status: res.status, body: res.ok ? ((await res.json()) as T) : null };
}

type EnvBody = { protection_rules?: { type: string; prevent_self_review?: boolean; reviewers?: unknown[] }[]; can_admins_bypass?: boolean };
const envState = (r: { status: number; body: EnvBody | null }): EnvState => {
  if (r.status === 404) return { exists: false, protected: false, readable: true };
  if (r.status !== 200 || !r.body) return { exists: false, protected: false, readable: false };
  const rv = r.body.protection_rules?.find((x) => x.type === "required_reviewers");
  return { exists: true, readable: true, protected: rv?.prevent_self_review === true && (rv.reviewers?.length ?? 0) > 0 && r.body.can_admins_bypass === false };
};

function savedCodeTargets(): { present: boolean; parses: boolean; value: Record<string, CodeTarget> } {
  const raw = process.env["CODE_TARGETS"];
  if (!raw) return { present: false, parses: false, value: {} };
  try { return { present: true, parses: true, value: parseCodeTargets(JSON.parse(raw)) }; } catch { return { present: true, parses: false, value: {} }; }
}

async function controls() {
  const { data, error } = await untyped(supabaseAdmin).from("code_runtime_controls").select("allowed_targets, active_request_id, active_run_id").eq("singleton", true).single();
  if (error || !data) throw new Error("CODE safety controls are unavailable.");
  let targets: Record<string, CodeTarget> = {};
  try { targets = parseCodeTargets(data.allowed_targets); } catch { targets = {}; }
  return { targets, activeTask: !!(data.active_request_id || data.active_run_id) };
}

/** True once the reviewed multi-site migration is applied. Probes with a call the function always refuses (no owner), so nothing is written. */
async function pinStorageReady(): Promise<boolean> {
  const { error } = await untyped(supabaseAdmin).rpc("set_code_site_pin", { p_actor: null, p_repository: "x/x", p_workflow_sha: null, p_add: false });
  if (!error) return false; // should never succeed without an owner; treat as not ready
  return /Only the owner/i.test(error.message);
}

async function project(projectId: string) {
  const { data } = await supabaseAdmin.from("owner_projects").select("id, name, github_repo").eq("id", projectId).single();
  if (!data) throw new Error("Project not found.");
  if (!data.github_repo) throw new Error(`${data.name} has no GitHub repository linked. Link one on the project page first.`);
  return { id: data.id, name: data.name, repo: data.github_repo };
}

async function gather(projectId: string) {
  const p = await project(projectId);
  let x: ws.Repo | null = null, appError: string | null = null;
  try { x = await ws.openRepo(p.repo); } catch (e) { appError = (e as Error).message; }
  const repoInfo = x ? null : await codeGh<{ default_branch: string }>(`/repos/${p.repo}`);
  const defaultBranch = x?.base ?? repoInfo?.body?.default_branch ?? null;

  let root: string[] = [], scripts: Record<string, string> | null = null, goFolders: string[] = [];
  if (x) {
    const list = await ws.repoGet<{ name: string; type: string }[]>(x, `/contents?ref=${encodeURIComponent(x.base)}`).catch(() => []);
    root = list.filter((e) => e.type === "file").map((e) => e.name);
    if (!root.includes("go.mod") && !root.includes("package.json")) {
      // Read-only: which top-level folders (first 12) hold their own go.mod, so the blocker can name them.
      const dirs = list.filter((e) => e.type === "dir" && !e.name.startsWith(".")).map((e) => e.name).slice(0, 12);
      const found = await Promise.all(dirs.map(async (d) => ((await ws.fileSha(x!, `${d}/go.mod`, x!.base).catch(() => null)) ? d : null)));
      goFolders = found.filter((d): d is string => d !== null);
    }
    if (root.includes("package.json")) {
      try { scripts = (JSON.parse((await ws.read(x, "package.json", x.base)).content) as { scripts?: Record<string, string> }).scripts ?? {}; } catch { scripts = {}; }
    }
  }
  const profile = x ? detectProfile(root, scripts, goFolders) : { kind: null, reason: appError ?? "Repository could not be read." } as const;
  const expected: ProfileFile[] = profile.kind ? await profileFiles(profile.kind) : [];

  const shas = async (ref: string) => {
    const out: Partial<Record<string, string | null>> = {};
    if (!x) return out;
    await Promise.all(Object.values(PROFILE_PATHS).map(async (path) => { out[path] = await ws.fileSha(x!, path, ref).catch(() => null); }));
    return out;
  };
  const [mainFiles, branchFiles] = await Promise.all([shas(defaultBranch ?? "main"), shas(ONBOARD_BRANCH)]);

  let pr: SiteFacts["pr"] = null;
  if (x) {
    const pulls = await ws.repoGet<{ number: number; html_url: string; state: string; merged_at: string | null }[]>(x, `/pulls?head=${encodeURIComponent(`${x.owner}:${ONBOARD_BRANCH}`)}&state=all&per_page=5`).catch(() => []);
    const last = pulls[0];
    if (last) pr = { number: last.number, url: last.html_url, state: last.merged_at ? "merged" : last.state === "open" ? "open" : "closed" };
  }

  const token = !!process.env["CODE_GITHUB_TOKEN"];
  const [envCode, envPublish, repoSeen, wf, variable] = await Promise.all([
    codeGh<EnvBody>(`/repos/${p.repo}/environments/CODE`),
    codeGh<EnvBody>(`/repos/${p.repo}/environments/CODE-PUBLISH`),
    codeGh<unknown>(`/repos/${p.repo}`),
    codeGh<{ state: string }>(`/repos/${p.repo}/actions/workflows/code.yml`),
    codeGh<{ value: string }>(`/repos/${p.repo}/actions/variables/CODE_RUNNER_AUTH_URL`),
  ]);
  const dispatchCredential: SiteFacts["dispatchCredential"] = !token ? "missing" : repoSeen.status !== 200 ? "no_access" : wf.status === 200 && wf.body?.state === "active" ? "ok" : "workflow_missing";
  const runnerVariable: SiteFacts["runnerVariable"] = variable.status === 200 ? (variable.body?.value?.replace(/\/$/, "") === CODE_RUNNER_ORIGIN ? "ok" : "wrong") : variable.status === 404 ? "missing" : "unreadable";

  const saved = savedCodeTargets();
  const c = await controls();
  const facts: SiteFacts = {
    repo: p.repo,
    defaultBranch,
    appCanWrite: !!x,
    profile,
    expected,
    branchFiles,
    mainFiles,
    pr,
    workflowWriteRefused: !!branchFiles[PROFILE_PATHS.patch] && !branchFiles[PROFILE_PATHS.workflow],
    environments: token ? { CODE: envState(envCode), "CODE-PUBLISH": envState(envPublish) } : null,
    dispatchCredential,
    runnerVariable,
    codeTargets: { present: saved.present, parses: saved.parses, entry: saved.value[p.repo] ?? null },
    pinned: c.targets[p.repo] ?? null,
    pinStorageReady: await pinStorageReady(),
    siteCount: Object.keys(c.targets).length,
    activeTask: c.activeTask,
  };
  return { project: p, x, facts, saved, pinnedTargets: c.targets };
}

/** Read-only status for one project's CODE onboarding. */
export async function siteStatus(projectId: string) {
  const g = await gather(projectId);
  const items = buildChecklist(g.facts);
  const wf = g.facts.expected.find((f) => f.path === PROFILE_PATHS.workflow);
  const base = g.saved.parses ? g.saved.value : g.pinnedTargets;
  return {
    checkedAt: new Date().toISOString(),
    projectId: g.project.id,
    name: g.project.name,
    repo: g.project.repo,
    anchor: g.project.repo === ANCHOR_REPO,
    profile: g.facts.profile.kind ? PROFILE_LABEL[g.facts.profile.kind] : null,
    workflowSha: wf?.sha ?? null,
    phase: sitePhase(items),
    items,
    blockReason: activationBlockReason(items),
    pr: g.facts.pr,
    branchUrl: `https://github.com/${g.project.repo}/tree/${ONBOARD_BRANCH}`,
    codeTargetsValue: wf ? nextCodeTargetsValue(base, g.project.repo, wf.sha) : null,
    codeTargetsAfterRemoval: codeTargetsWithout(base, g.project.repo),
    // Only offered when GitHub refused the App's workflow write: the exact bytes to add by hand.
    workflowFile: g.facts.workflowWriteRefused && wf ? { path: wf.path, content: wf.content, addUrl: `https://github.com/${g.project.repo}/new/${ONBOARD_BRANCH}?filename=${encodeURIComponent(wf.path)}` } : null,
  };
}

/** One button: write the approved files to jackboy/code-onboarding and open a draft PR with exactly those files. */
export async function prepareSite(projectId: string, actor: string) {
  const g = await gather(projectId);
  if (g.project.repo === ANCHOR_REPO) throw new Error("Jackboy Dev Control is already the anchor CODE site; it keeps its own reviewed workflow.");
  if (!g.x) throw new Error(`Jackboy can't write to ${g.project.repo}: add it to the OMERTA-ROW GitHub App installation first.`);
  if (!g.facts.profile.kind) throw new Error(g.facts.profile.reason);
  if (g.facts.defaultBranch !== "main") throw new Error("CODE pins only main. Rename the default branch to main first.");
  const changed = g.facts.expected.filter((f) => g.facts.mainFiles[f.path] !== f.sha);
  if (!changed.length) { await log(actor, g, "code.site_prepare", "info", "Approved CODE files are already on main; nothing to propose."); return { pr: null, notes: ["The approved files are already on main."] }; }

  const notes: string[] = [];
  let workflowRefused = false;
  for (const f of changed) {
    if (g.facts.branchFiles[f.path] === f.sha) continue; // already on the branch
    try {
      await ws.write(g.x, ONBOARD_BRANCH, f.path, f.content, `CODE onboarding: add approved ${f.path}`);
    } catch (e) {
      const m = (e as Error).message;
      if (f.path === PROFILE_PATHS.workflow && /workflow/i.test(m) && /GitHub (403|404)/.test(m)) {
        workflowRefused = true;
        notes.push("GitHub refused to let the App add the workflow file (no Workflows permission). Add it yourself from the checklist, then Prepare again.");
        continue;
      }
      await log(actor, g, "code.site_prepare", "failed", `Writing ${f.path} failed: ${m}`);
      throw new Error(`Writing ${f.path} failed: ${m}`);
    }
  }
  const proposed = changed.filter((f) => !(workflowRefused && f.path === PROFILE_PATHS.workflow));
  const body = [
    `Adds the approved CODE workflow version (${PROFILE_LABEL[g.facts.profile.kind]}) and its helper scripts so Jackboy CODE can run on this repository.`,
    "",
    ...changed.map((f) => `- \`${f.path}\` blob ${f.sha}`),
    "",
    "After merging: CODE and CODE-PUBLISH environments must require your review, CODE_TARGETS must list this repo, and you approve the pin with your passkey in Jackboy. Every run still waits for your approval in GitHub.",
  ].join("\n");
  const pr = await ws.openExactDraftPr(g.x, ONBOARD_BRANCH, "CODE onboarding: add the approved CODE workflow", body, proposed.map((f) => ({ path: f.path, sha: f.sha })));
  await log(actor, g, "code.site_prepare", "ok", `${pr.existed ? "Updated" : "Opened"} CODE onboarding draft PR #${pr.number}${workflowRefused ? " (workflow file still to be added by the owner)" : ""}.`, pr.url);
  return { pr, notes };
}

/** After a fresh passkey: re-check every gate live, then pin the site. */
export async function activateSite(projectId: string, actor: string, grantId: string, expectedSha: string) {
  const g = await gather(projectId);
  const wf = g.facts.expected.find((f) => f.path === PROFILE_PATHS.workflow);
  if (!wf || wf.sha !== expectedSha) throw new Error("The approved workflow version changed since you looked. Re-check, then approve again.");
  const reason = activationBlockReason(buildChecklist(g.facts));
  if (reason) throw new Error(`Not activated. ${reason}`);
  const { siteAddTarget } = await import("./code-onboarding");
  await (await import("./passkey.server")).consumeGrant(grantId, actor, "code_site_pin", siteAddTarget(g.project.repo, wf.sha), { requireFresh: true });
  const { data, error } = await untyped(supabaseAdmin).rpc("set_code_site_pin", { p_actor: actor, p_repository: g.project.repo, p_workflow_sha: wf.sha, p_add: true });
  if (error) { await log(actor, g, "code.site_pin", "failed", `Pin refused: ${error.message}`); throw new Error(`Pin refused: ${error.message}`); }
  await log(actor, g, "code.site_pin", "ok", `${g.project.repo} added to the CODE allow list on main with workflow ${wf.sha}.`);
  return { repo: g.project.repo, workflowSha: wf.sha, sites: Object.keys((data ?? {}) as Record<string, unknown>).length };
}

/** After a fresh passkey: take a site off the allow list. History stays in the audit log and Site Log. */
export async function removeSite(projectId: string, actor: string, grantId: string) {
  const p = await project(projectId);
  if (p.repo === ANCHOR_REPO) throw new Error("The Jackboy anchor site can't be removed here.");
  const { siteRemoveTarget } = await import("./code-onboarding");
  await (await import("./passkey.server")).consumeGrant(grantId, actor, "code_site_pin", siteRemoveTarget(p.repo), { requireFresh: true });
  const { error } = await untyped(supabaseAdmin).rpc("set_code_site_pin", { p_actor: actor, p_repository: p.repo, p_workflow_sha: null, p_add: false });
  if (error) throw new Error(`Removal refused: ${error.message}`);
  const { logSite } = await import("./site-log.server");
  await logSite({ actor, action: "code.site_unpin", category: "config", status: "ok", summary: `${p.repo} removed from the CODE allow list.`, project_id: p.id, repo: p.repo });
  return { repo: p.repo };
}

/** All linked projects with their pin state (cheap: database + saved setting only, no GitHub calls). */
export async function siteList() {
  const { data } = await supabaseAdmin.from("owner_projects").select("id, name, github_repo").not("github_repo", "is", null).order("name");
  const c = await controls();
  const saved = savedCodeTargets();
  return (data ?? []).map((p) => {
    const pin = c.targets[p.github_repo!] ?? null;
    const policy = saved.value[p.github_repo!] ?? null;
    return { projectId: p.id, name: p.name, repo: p.github_repo!, anchor: p.github_repo === ANCHOR_REPO, pinned: !!pin, usable: !!pin && !!policy && pin.workflowSha === policy.workflowSha && pin.ref === policy.ref };
  });
}

async function log(actor: string, g: { project: { id: string; repo: string } }, action: string, status: "ok" | "failed" | "info", summary: string, url?: string) {
  const { logSite } = await import("./site-log.server");
  await logSite({ actor, action, category: "config", status, summary, project_id: g.project.id, repo: g.project.repo, branch: ONBOARD_BRANCH, pr_url: url ?? null });
}

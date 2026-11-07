// Server side of the two CODE approval lanes. Read-only checks and trial labels; the automatic lane stays
// unavailable until the staged database update (staging/code-lane/0051) is applied and the owner turns it on per site.
import { supabaseAdmin as typedDb } from "@/integrations/supabase/client.server";
import { untyped } from "./untyped-db";
import { AUTO_ENVS, AUTO_HOLD_USD, autoEnvProblems, classifyPatch, trialLane, type EnvBody, type PatchFile } from "./code-lane";
import { logSite } from "./site-log.server";

const db = untyped(typedDb);
const API = "https://api.github.com";

async function codeGh<T>(path: string): Promise<{ status: number; body: T | null }> {
  const token = process.env["CODE_GITHUB_TOKEN"];
  if (!token) return { status: 0, body: null };
  const headers = new Headers({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Jackboy" });
  headers.set("Authorization", ["Bearer", token].join(" "));
  const res = await fetch(`${API}${path}`, { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (!res) return { status: 0, body: null };
  return { status: res.status, body: res.ok ? ((await res.json()) as T) : null };
}

/** True only when the owner turned the automatic lane on for this site AND the storage exists. Any error means no. */
export async function autoLaneAllowed(repo: string): Promise<boolean> {
  try {
    const { data, error } = await db.from("code_auto_lane").select("enabled").eq("repo", repo).maybeSingle();
    return !error && data?.enabled === true;
  } catch {
    return false;
  }
}

/** Automatic runs already started on this site today (UTC). Errors count as the limit, so the lane closes. */
export async function autoRunsToday(repo: string): Promise<number> {
  const since = new Date(); since.setUTCHours(0, 0, 0, 0);
  const { count, error } = await db.from("action_requests").select("id", { count: "exact", head: true })
    .eq("action", "code").eq("resources->>repo", repo).eq("resources->>lane", "auto").gte("created_at", since.toISOString());
  return error ? 999 : count ?? 999;
}

/** Trial mode: label a new request with the lane it WOULD get. Never changes the request. */
export async function logRequestTrial(requestId: string, projectId: string, repo: string, instruction: string, killSwitch: boolean) {
  try {
    const t = trialLane({ instruction, siteAutoEnabled: true, killSwitch, failureStop: false, autoRunsToday: 0, holdUsd: AUTO_HOLD_USD, spendBlocked: null });
    await logSite({ actor: "code-lane", action: "code.lane_trial", category: "approval", status: "info", project_id: projectId, repo,
      summary: t.wouldAuto ? "Trial: this request would have started automatically (it still waits for your GitHub approval)." : `Trial: this request would need review — ${t.reasons.join(" ")}`,
      detail: { request: requestId, stage: "request", wouldAuto: t.wouldAuto, reasons: t.reasons } });
  } catch { /* trial labels never block CODE */ }
}

/** Trial mode: after a finished run, label whether its actual patch would have published automatically. */
export async function logPatchTrial(requestId: string, repo: string, baseSha: string, correlation: string) {
  try {
    const r = await codeGh<{ files?: { filename: string; status: string; additions: number; deletions: number }[] }>(
      `/repos/${repo}/compare/${baseSha}...${encodeURIComponent(`jackboy/code-${correlation}`)}`);
    if (r.status !== 200 || !r.body?.files) return;
    const files: PatchFile[] = r.body.files.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions }));
    const c = classifyPatch({ files, fileCount: files.length });
    await logSite({ actor: "code-lane", action: "code.lane_trial", category: "approval", status: "info", repo,
      summary: c.lowRisk ? `Trial: this patch (${files.length} file(s)) would have opened its draft PR automatically.` : `Trial: this patch would need review — ${c.reasons.join(" ")}`,
      detail: { request: requestId, stage: "patch", wouldAuto: c.lowRisk, reasons: c.reasons, files: files.map((f) => f.path) } });
  } catch { /* trial labels never block CODE */ }
}

async function envCheck(repo: string, name: string) {
  const env = await codeGh<EnvBody>(`/repos/${repo}/environments/${name}`);
  if (env.status === 404) return { name, problems: ["Not created yet."], readable: true };
  if (env.status !== 200) return { name, problems: ["Couldn't read this environment with Jackboy's current access."], readable: false };
  const [b, s, v] = await Promise.all([
    codeGh<{ branch_policies?: { name: string }[] }>(`/repos/${repo}/environments/${name}/deployment-branch-policies`),
    codeGh<{ total_count?: number }>(`/repos/${repo}/environments/${name}/secrets?per_page=1`),
    codeGh<{ total_count?: number }>(`/repos/${repo}/environments/${name}/variables?per_page=1`),
  ]);
  return {
    name, readable: true,
    problems: autoEnvProblems(env.body, b.body?.branch_policies ? b.body.branch_policies.map((x) => x.name) : null,
      typeof s.body?.total_count === "number" ? s.body.total_count : null, typeof v.body?.total_count === "number" ? v.body.total_count : null),
  };
}

/** Owner view: per CODE site, the two automatic environments (read-only), the switch state and the trial log. */
export async function laneStatus() {
  const { getCodeSafetyState } = await import("./code-safety.server");
  const state = await getCodeSafetyState();
  const repos = Object.keys(state.allowedTargets ?? {});
  const storage = await db.from("code_auto_lane").select("repo, enabled, updated_at");
  const storageReady = !storage.error;
  const sites = await Promise.all(repos.map(async (repo) => ({
    repo,
    enabled: storageReady && (storage.data ?? []).some((r: { repo: string; enabled: boolean }) => r.repo === repo && r.enabled),
    environments: await Promise.all(AUTO_ENVS.map((n) => envCheck(repo, n))),
  })));
  const { data: trials } = await typedDb.from("site_log").select("at, summary, repo, detail").eq("action", "code.lane_trial").order("at", { ascending: false }).limit(20);
  return { storageReady, sites, trials: (trials ?? []).map((t) => ({ at: t.at, summary: t.summary, repo: t.repo, wouldAuto: (t.detail as { wouldAuto?: boolean } | null)?.wouldAuto === true })), checkedAt: new Date().toISOString() };
}

import { assessRepoAccess, type RepoInfo } from "./repo-workspace";
// AutoConnect runtime (server-only). Verifies capabilities with real API calls and resumes waiting Foundry work.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { afterApproval, afterVerify, canVerify, capabilityForTestGap, capById, type CapStatus } from "./autoconnect";
import { logSite } from "./site-log.server";

const AUTO_CAPS = ["github_repo", "github_actions_read", "model_provider", "browser_runner", "deploy_api"];

type Grant = { id: string; capability: string; project_id: string; status: CapStatus; paused: boolean; verify_attempts: number; expires_at: string | null };

async function grant(cap: string, projectId: string): Promise<Grant> {
  const { data } = await supabaseAdmin.from("capability_grants").select("*").eq("capability", cap).eq("project_id", projectId).maybeSingle();
  if (data) return data as unknown as Grant;
  const c = capById(cap);
  const { data: row, error } = await supabaseAdmin.from("capability_grants").insert({ capability: cap, project_id: projectId, status: c?.verifiable ? "needs_approval" : "unavailable", method: c?.method ?? "", scopes: c?.scopes ?? "" }).select("*").single();
  if (error || !row) throw new Error(error?.message ?? "grant insert failed");
  return row as unknown as Grant;
}

/** Finds what each project with a repo is missing, including capabilities blocking Foundry tests. */
export async function scanCapabilities() {
  const { data: projects } = await supabaseAdmin.from("owner_projects").select("id").eq("active", true).not("github_repo", "is", null);
  for (const p of projects ?? []) for (const c of AUTO_CAPS) await grant(c, p.id);
  const { data: tasks } = await supabaseAdmin.from("foundry_tasks").select("id, project_id, test_evidence, needs_capability").is("needs_capability", null).in("state", ["awaiting_approval", "blocked", "testing"]);
  for (const t of tasks ?? []) {
    const ev = t.test_evidence as { status?: string; reason?: string };
    const cap = ev?.status === "not_runnable" ? capabilityForTestGap(ev.reason ?? "") : null;
    if (cap) { await supabaseAdmin.from("foundry_tasks").update({ needs_capability: cap }).eq("id", t.id); await grant(cap, t.project_id); }
  }
  return { projects: projects?.length ?? 0 };
}

export async function approveCapability(cap: string, projectId: string, actor: string, ownerId: string) {
  const c = capById(cap); if (!c) throw new Error("Unknown capability.");
  const g = await grant(cap, projectId);
  const status = afterApproval(c);
  await supabaseAdmin.from("capability_grants").update({ status, approved_by: ownerId, approved_at: new Date().toISOString(), verify_attempts: 0, last_error: status === "unavailable" ? "No supported adapter." : null, paused: false, updated_at: new Date().toISOString() }).eq("id", g.id);
  await logSite({ actor, action: "capability_approved", category: "approval", status: "pending", project_id: projectId, summary: `Approved setup of ${c.name} (${c.scopes}). Not connected until verified.` });
  return { status };
}

async function realCheck(cap: string, repoFull: string | null): Promise<{ ok: boolean; account: string | null; detail: string }> {
  const token = process.env["GITHUB_TOKEN"];
  const gh = async (path: string) => fetch(`https://api.github.com${path}`, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "Jackboy", "X-GitHub-Api-Version": "2022-11-28" } });
  const post = (path: string, method: string, body?: unknown) => fetch(`https://api.github.com${path}`, { method, signal: AbortSignal.timeout(10_000), body: body ? JSON.stringify(body) : null, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "Jackboy", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" } });
  if (cap === "model_provider") {
    const key = process.env["LOVABLE_API_KEY"];
    if (!key) return { ok: false, account: null, detail: "AI key missing on the server." };
    const r = await fetch("https://ai.gateway.lovable.dev/v1/models", { signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${key}` } }).catch(() => null);
    return { ok: !!r?.ok, account: "Lovable AI", detail: r?.ok ? "Model list reachable." : `Check failed (${r?.status ?? "network"}).` };
  }
  if (cap === "github_repo" || cap === "github_actions_read") {
    if (!token) return { ok: false, account: null, detail: "GITHUB_TOKEN secret missing." };
    if (!repoFull) return { ok: false, account: null, detail: "Project has no repo." };
    const u = await gh("/user"); const login = u.ok ? ((await u.json()) as { login: string }).login : null;
    if (cap === "github_repo") {
      const r = await gh(`/repos/${repoFull}`);
      if (!r.ok) return { ok: false, account: login, detail: `GitHub ${r.status} reading repo.` };
      const j = (await r.json()) as RepoInfo & { default_branch: string };
      const a = assessRepoAccess(j);
      const who = `${a.visibility} repo${a.org ? ` in org ${a.org}` : ""}`;
      if (!a.canWrite) return { ok: false, account: login, detail: `${who}: ${a.reason}` };
      // Prove real branch write: create and delete a throwaway jackboy/ ref.
      const head = await gh(`/repos/${repoFull}/git/ref/heads/${encodeURIComponent(j.default_branch)}`);
      if (!head.ok) return { ok: false, account: login, detail: `${who}: read of ${j.default_branch} failed (${head.status}).` };
      const sha = ((await head.json()) as { object: { sha: string } }).object.sha;
      const ref = `jackboy/access-check-${Date.now()}`;
      const mk = await post(`/repos/${repoFull}/git/refs`, "POST", { ref: `refs/heads/${ref}`, sha });
      if (!mk.ok) return { ok: false, account: login, detail: `${who}: read OK, branch create refused (${mk.status}). Token needs Contents: write.` };
      await post(`/repos/${repoFull}/git/refs/heads/${ref}`, "DELETE");
      const pr = await gh(`/repos/${repoFull}/pulls?per_page=1`);
      return pr.ok ? { ok: true, account: login, detail: `${who}: read, branch write and PR list verified.` } : { ok: false, account: login, detail: `${who}: branch write OK, pull requests unreadable (${pr.status}).` };
    }
    const r = await gh(`/repos/${repoFull}/actions/runs?per_page=1`);
    return r.ok ? { ok: true, account: login, detail: "Actions run list readable." } : { ok: false, account: login, detail: `GitHub ${r.status}: token lacks Actions: Read-only on ${repoFull}.` };
  }
  return { ok: false, account: null, detail: "No supported adapter." };
}

/** Real API verification. On success, resumes waiting Foundry tasks for this project automatically. */
export async function verifyCapability(cap: string, projectId: string, actor: string) {
  const g = await grant(cap, projectId);
  const bad = canVerify(g); if (bad) throw new Error(bad);
  const { data: p } = await supabaseAdmin.from("owner_projects").select("github_repo").eq("id", projectId).single();
  const res = await realCheck(cap, p?.github_repo ?? null);
  const status = afterVerify(res.ok, g.expires_at);
  await supabaseAdmin.from("capability_grants").update({ status, account: res.account, last_verified_at: new Date().toISOString(), last_error: res.ok ? null : res.detail, verify_attempts: res.ok ? 0 : g.verify_attempts + 1, updated_at: new Date().toISOString() }).eq("id", g.id);
  await logSite({ actor, action: "capability_verified", category: "config", status: res.ok ? "ok" : "blocked", project_id: projectId, summary: `${capById(cap)?.name ?? cap}: ${res.detail}` });
  const resumed = status === "connected" ? await resume(cap, projectId, actor) : 0;
  return { status, detail: res.detail, resumed };
}

/** Re-runs only the step that was waiting on this capability. Idempotent: clears needs_capability once done. */
async function resume(cap: string, projectId: string, actor: string) {
  const { data: tasks } = await supabaseAdmin.from("foundry_tasks").select("id, state, repo, branch, approved_action, test_evidence").eq("project_id", projectId).eq("needs_capability", cap).limit(10);
  let n = 0;
  for (const t of tasks ?? []) {
    try {
      if (cap === "github_actions_read" && t.state === "awaiting_approval" && t.repo && t.branch) {
        const ws = await import("./repo-workspace.server");
        const ck = await ws.checks(await ws.openRepo(t.repo), t.branch);
        const ev = "error" in ck && ck.error ? { status: "not_runnable", reason: ck.error } : !ck.workflowsConfigured ? { status: "not_runnable", reason: "No CI workflows on this repo yet." } : !ck.runs.length ? { status: "pending", reason: "No CI runs for this branch yet." } : { status: ck.runs.every((r) => r.conclusion === "success") ? "passed" : ck.runs.some((r) => r.conclusion === "failure") ? "failed" : "pending", runs: ck.runs };
        await supabaseAdmin.from("foundry_tasks").update({ test_evidence: ev as never, needs_capability: null, updated_at: new Date().toISOString() }).eq("id", t.id);
        await supabaseAdmin.from("foundry_events").insert({ task_id: t.id, project_id: projectId, action: "resumed_tests", actor, from_state: t.state, to_state: t.state, note: `Tests re-read after ${cap} connected: ${ev.status}` });
        await logSite({ actor, action: "foundry.resumed_tests", category: "test", status: ev.status === "passed" ? "ok" : "pending", project_id: projectId, task_id: t.id, branch: t.branch, tests: ev.status, summary: `Resumed waiting task after ${cap} connected: tests ${ev.status}.` });
        n++;
      } else if (t.state === "blocked" && t.approved_action) {
        const f = await import("./foundry.server");
        await supabaseAdmin.from("foundry_tasks").update({ needs_capability: null }).eq("id", t.id);
        await f.retryBlocked(t.id, actor); n++;
      }
    } catch (e) { await logSite({ actor, action: "resume_failed", category: "error", status: "failed", project_id: projectId, task_id: t.id, summary: (e as Error).message }); }
  }
  return n;
}

export async function setGrant(cap: string, projectId: string, actor: string, op: "pause" | "resume" | "revoke") {
  const g = await grant(cap, projectId);
  const patch = op === "revoke" ? { status: "revoked" as const, paused: true } : { paused: op === "pause" };
  await supabaseAdmin.from("capability_grants").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", g.id);
  await logSite({ actor, action: `capability_${op}`, category: "config", status: op === "revoke" ? "blocked" : "info", project_id: projectId, summary: `${capById(cap)?.name ?? cap}: ${op}${op === "revoke" ? ". Also revoke the token on GitHub to remove access." : ""}` });
}

/** Hourly: re-verify approved/connected grants (bounded) so health stays current and waiting work resumes. */
export async function autoconnectTick() {
  await scanCapabilities();
  const { data } = await supabaseAdmin.from("capability_grants").select("capability, project_id, status, paused, verify_attempts").in("status", ["awaiting_setup", "connected", "error"]).eq("paused", false).order("last_verified_at", { ascending: true, nullsFirst: true }).limit(5);
  let checked = 0;
  for (const g of data ?? []) { try { await verifyCapability(g.capability, g.project_id, "scheduler"); checked++; } catch { /* limit reached etc. */ } }
  return { checked };
}

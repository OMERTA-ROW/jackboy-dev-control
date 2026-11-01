// Code Foundry runtime (server-only). Uses real repo tools; every state change writes an immutable event.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertTransition, canApprove, canExecute, classifyRisk, idempotencyKey, nextProject, quotaLeft, type ApprovedAction, type State } from "./foundry";
import * as ws from "./repo-workspace.server";

type Task = {
  id: string; project_id: string; state: State; title: string; repo: string | null; branch: string | null;
  approved_action: string | null; paused: boolean; attempts: number; max_attempts: number;
  test_evidence: Record<string, unknown>; pr_url: string | null; dedupe_key: string; idempotency_key: string | null;
};

async function event(task: Pick<Task, "id" | "project_id"> | null, action: string, actor: string, from: State | null, to: State | null, note = "", detail: Record<string, unknown> = {}) {
  await supabaseAdmin.from("foundry_events").insert({ task_id: task?.id ?? null, project_id: task?.project_id ?? null, action, actor, from_state: from, to_state: to, note: note.slice(0, 2000), detail: detail as never });
}

async function move(t: Task, to: State, actor: string, note = "", patch: Record<string, unknown> = {}) {
  assertTransition(t.state, to);
  const { error } = await supabaseAdmin.from("foundry_tasks").update({ ...patch, state: to, updated_at: new Date().toISOString() } as never).eq("id", t.id).eq("state", t.state);
  if (error) throw new Error(error.message);
  await event(t, "transition", actor, t.state, to, note, patch);
  Object.assign(t, patch, { state: to });
}

async function load(id: string): Promise<Task> {
  const { data, error } = await supabaseAdmin.from("foundry_tasks").select("*").eq("id", id).single();
  if (error || !data) throw new Error("Task not found.");
  return data as unknown as Task;
}

/** Real rule-based inspections over the repo tree. Each returns a concrete low-risk patch. */
type Check = { key: string; title: string; summary: string; kind: "docs" | "test" | "repair"; path: string; content: (repo: string) => string };
const CHECKS: Check[] = [
  { key: "missing-security-md", kind: "docs", path: "SECURITY.md", title: "Add a security policy (SECURITY.md)",
    summary: "The repository has no SECURITY.md, so there is no documented way to report vulnerabilities privately.",
    content: (repo) => `# Security policy\n\nThis is a private repository (${repo}).\n\n## Reporting a vulnerability\n\nDo not open public issues for security problems. Contact the repository owner privately with steps to reproduce.\n\n## Handling\n\n- Secrets live only in backend secret storage, never in source.\n- Sensitive changes (auth, payments, secrets, permissions) require explicit owner approval.\n` },
  { key: "missing-editorconfig", kind: "repair", path: ".editorconfig", title: "Add .editorconfig for consistent formatting",
    summary: "No .editorconfig found; editors may mix indentation and line endings.",
    content: () => `root = true\n\n[*]\ncharset = utf-8\nend_of_line = lf\nindent_style = space\nindent_size = 2\ninsert_final_newline = true\ntrim_trailing_whitespace = true\n` },
];

export async function inspectProject(projectId: string, actor: string, source: "manual" | "scheduled", limit = 1) {
  const { data: p } = await supabaseAdmin.from("owner_projects").select("id, name, github_repo").eq("id", projectId).single();
  if (!p) throw new Error("Project not found.");
  if (!p.github_repo) { await event({ id: null as never, project_id: p.id }, "inspect_blocked", actor, null, null, "No private repo linked."); return { created: 0, blocked: "No private GitHub repo linked to this project." }; }
  let repo: ws.Repo;
  try { repo = await ws.openRepo(p.github_repo); }
  catch (e) { const m = (e as Error).message; await event({ id: null as never, project_id: p.id }, "inspect_blocked", actor, null, null, m); return { created: 0, blocked: m }; }
  const t = await ws.tree(repo, repo.base);
  const have = new Set(t.files);
  const found = CHECKS.filter((c) => !have.has(c.path));
  let created = 0; const ids: string[] = [];
  for (const c of found) {
    if (created >= limit) break;
    const { data: existing } = await supabaseAdmin.from("foundry_tasks").select("id").eq("project_id", p.id).eq("dedupe_key", c.key).maybeSingle();
    if (existing) continue; // dedupe: never re-propose the same finding
    const { data: row, error } = await supabaseAdmin.from("foundry_tasks").insert({
      project_id: p.id, title: c.title, summary: c.summary, kind: c.kind, dedupe_key: c.key, repo: repo.full, source,
      risk: classifyRisk([{ path: c.path }]), files: [{ path: c.path, action: "create" }] as never,
    }).select("*").single();
    if (error || !row) continue;
    const task = row as unknown as Task;
    await event(task, "discovered", actor, null, "discovered", c.summary, { inspectedFiles: t.total });
    created++; ids.push(task.id);
    await prepare(task, c, repo, actor).catch(async (e) => {
      const msg = (e as Error).message;
      if (task.state === "analyzing" || task.state === "patch_prepared" || task.state === "testing") await move(task, "blocked", actor, msg, { blocked_reason: msg }).catch(() => {});
    });
  }
  return { created, ids, inspectedFiles: t.total, findings: found.length };
}

async function prepare(task: Task, c: Check, repo: ws.Repo, actor: string) {
  await move(task, "analyzing", actor, "Reading repository tree.");
  const branch = `jackboy/foundry-${c.key}`;
  const w = await ws.write(repo, branch, c.path, c.content(repo.full), c.title);
  await move(task, "patch_prepared", actor, `Committed ${w.path} on ${branch}.`, { branch, commit_sha: w.commit });
  await move(task, "testing", actor, "Reading CI checks for the branch.");
  const ck = await ws.checks(repo, branch);
  let evidence: Record<string, unknown>;
  if ("error" in ck && ck.error) evidence = { status: "not_runnable", reason: ck.error };
  else if (!ck.workflowsConfigured) evidence = { status: "not_runnable", reason: "No CI workflows exist on this repo, and no sandbox runner is connected." };
  else if (!ck.runs.length) evidence = { status: "pending", reason: "No CI runs reported yet for this branch.", workflows: ck.workflowsConfigured };
  else evidence = { status: ck.runs.every((r) => r.conclusion === "success") ? "passed" : ck.runs.some((r) => r.conclusion === "failure") ? "failed" : "pending", runs: ck.runs };
  const d = await ws.diff(repo, branch);
  await move(task, "awaiting_approval", actor, `Tests: ${String(evidence["status"])}. Waiting for owner.`, { test_evidence: evidence, files: d.files.map((f) => ({ path: f.file, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch })) });
}

export async function decide(id: string, actor: string, decision: "approve" | "reject", action: ApprovedAction = "open_draft_pr") {
  const t = await load(id);
  if (decision === "reject") { assertTransition(t.state, "rejected"); await move(t, "rejected", actor, "Owner rejected."); return t; }
  const bad = canApprove(t); if (bad) throw new Error(bad);
  await move(t, "approved", actor, `Owner approved exactly: ${action}.`, { approved_action: action });
  return execute(id, actor);
}

/** Performs ONLY the approved action, idempotently, with bounded retries. Never merges or deploys. */
export async function execute(id: string, actor: string) {
  const t = await load(id);
  const bad = canExecute(t); if (bad) throw new Error(bad);
  const action = t.approved_action as ApprovedAction;
  const key = idempotencyKey(t.id, action, t.attempts + 1);
  await move(t, "executing", actor, `Running ${action}.`, { attempts: t.attempts + 1, idempotency_key: key });
  try {
    if (!t.repo || !t.branch) throw new Error("Task has no repo/branch.");
    const repo = await ws.openRepo(t.repo);
    if (action === "open_draft_pr") {
      const pr = await ws.openDraftPr(repo, t.branch, t.title, `Code Foundry task ${t.id}\n\nTest evidence: ${JSON.stringify(t.test_evidence).slice(0, 1500)}`);
      await move(t, "verifying", actor, pr.existed ? "Draft PR already existed (idempotent)." : "Draft PR opened.", { pr_number: pr.number, pr_url: pr.url });
      const dd = await ws.diff(repo, t.branch);
      if (dd.commitsAhead < 1) throw new Error("Branch has no commits ahead of base.");
      await move(t, "completed", actor, `Verified draft PR #${pr.number} with ${dd.files.length} file(s). Not merged.`);
    } else {
      const ck = await ws.checks(repo, t.branch);
      await move(t, "verifying", actor, "Checks read.", { test_evidence: { ...t.test_evidence, latest: ck } });
      await move(t, "completed", actor, "Check results recorded.");
    }
    if (t.test_evidence["status"] === "passed") {
      const { data: pat } = await supabaseAdmin.from("foundry_patterns").select("id, verified_count").eq("key", t.dedupe_key).maybeSingle();
      if (pat) await supabaseAdmin.from("foundry_patterns").update({ verified_count: pat.verified_count + 1, last_task_id: t.id, updated_at: new Date().toISOString() }).eq("id", pat.id);
      else await supabaseAdmin.from("foundry_patterns").insert({ key: t.dedupe_key, title: t.title, verified_count: 1, last_task_id: t.id });
    }
  } catch (e) {
    const msg = (e as Error).message.slice(0, 500);
    const unavailable = /not connected|missing|401|403|Refused/i.test(msg);
    if (unavailable) await move(t, "blocked", actor, msg, { blocked_reason: msg });
    else await move(t, "failed", actor, msg, { blocked_reason: msg });
  }
  return load(id);
}

export async function setPaused(id: string, actor: string, paused: boolean) {
  const t = await load(id);
  await supabaseAdmin.from("foundry_tasks").update({ paused, updated_at: new Date().toISOString() }).eq("id", id);
  await event(t, paused ? "paused" : "resumed", actor, t.state, t.state);
}

/** Retry a blocked task's approved action once the connector is available. */
export async function retryBlocked(id: string, actor: string) {
  const t = await load(id);
  if (t.state !== "blocked" || !t.approved_action) throw new Error("Only blocked tasks with an approved action can be retried.");
  await move(t, "approved", actor, "Owner retried after unblock.", { blocked_reason: null });
  return execute(id, actor);
}

/** Recurring scoped inspection: one project per tick, rotating, under daily quota. Never approves anything. */
export async function foundryTick() {
  const { data: s } = await supabaseAdmin.from("foundry_schedule").select("*").eq("id", 1).single();
  if (!s?.enabled) return { skipped: "disabled" };
  if (s.last_run_at && Date.now() - new Date(s.last_run_at).getTime() < s.interval_hours * 3600_000) return { skipped: "not due" };
  const since = new Date(Date.now() - 86400_000).toISOString();
  const { count } = await supabaseAdmin.from("foundry_tasks").select("id", { count: "exact", head: true }).eq("source", "scheduled").gte("created_at", since);
  const left = quotaLeft(s.daily_task_quota, count ?? 0);
  const { data: projects } = await supabaseAdmin.from("owner_projects").select("id").eq("active", true).not("github_repo", "is", null).order("created_at");
  const p = nextProject(projects ?? [], s.last_project_id);
  await supabaseAdmin.from("foundry_schedule").update({ last_run_at: new Date().toISOString(), last_project_id: p?.id ?? null }).eq("id", 1);
  if (!p || left === 0) return { skipped: left === 0 ? "quota reached" : "no projects" };
  return inspectProject(p.id, "scheduler", "scheduled", Math.min(1, left));
}

export async function setSchedule(actor: string, v: { enabled: boolean; interval_hours: number; daily_task_quota: number }) {
  await supabaseAdmin.from("foundry_schedule").update({ ...v, updated_at: new Date().toISOString() }).eq("id", 1);
  await event(null, "schedule_changed", actor, null, null, "", v);
}

// Code Foundry runtime (server-only). Uses real repo tools; every state change writes an immutable event.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { assertTransition, backoffMs, budget, canApprove, canExecute, classifyRisk, idempotencyKey, IN_FLIGHT, isTransient, nextProject, quotaLeft, type ApprovedAction, type State } from "./foundry";
import * as ws from "./repo-workspace.server";
import { capabilityForTestGap } from "./autoconnect";

type Task = {
  id: string; project_id: string; state: State; title: string; repo: string | null; branch: string | null;
  approved_action: string | null; paused: boolean; attempts: number; max_attempts: number;
  test_evidence: Record<string, unknown>; pr_url: string | null; dedupe_key: string; idempotency_key: string | null;
};

async function event(task: Pick<Task, "id" | "project_id"> | null, action: string, actor: string, from: State | null, to: State | null, note = "", detail: Record<string, unknown> = {}) {
  await supabaseAdmin.from("foundry_events").insert({ task_id: task?.id ?? null, project_id: task?.project_id ?? null, action, actor, from_state: from, to_state: to, note: note.slice(0, 2000), detail: detail as never });
  const cat = to === "patch_prepared" ? "patch" : to === "testing" || to === "awaiting_approval" ? "test" : to === "approved" || to === "rejected" ? "approval" : to === "failed" ? "error" : to === "rolled_back" ? "rollback" : action.includes("inspect") || to === "discovered" ? "inspection" : action.includes("schedule") || action.includes("pause") ? "config" : "activity";
  const st = to === "completed" ? "ok" : to === "failed" ? "failed" : to === "blocked" ? "blocked" : to === "rolled_back" ? "rolled_back" : to === "awaiting_approval" ? "pending" : "info";
  const d = detail as { branch?: string; commit_sha?: string; pr_url?: string; test_evidence?: { status?: string } };
  const { logSite } = await import("./site-log.server");
  await logSite({ actor, action: `foundry.${action}${to ? `:${to}` : ""}`, category: cat, status: st, summary: note || `${action}${to ? ` → ${to}` : ""}`, project_id: task?.project_id ?? null, task_id: task?.id ?? null, branch: d.branch ?? null, commit_sha: d.commit_sha ?? null, pr_url: d.pr_url ?? null, tests: d.test_evidence?.status ?? null });
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
type Check = { key: string; title: string; summary: string; kind: "docs" | "test" | "repair"; priority: number; path: string; content: (repo: string) => string };
const CHECKS: Check[] = [
  { key: "missing-security-md", kind: "docs", priority: 70, path: "SECURITY.md", title: "Add a security policy (SECURITY.md)",
    summary: "The repository has no SECURITY.md, so there is no documented way to report vulnerabilities privately.",
    content: (repo) => `# Security policy\n\nThis is a private repository (${repo}).\n\n## Reporting a vulnerability\n\nDo not open public issues for security problems. Contact the repository owner privately with steps to reproduce.\n\n## Handling\n\n- Secrets live only in backend secret storage, never in source.\n- Sensitive changes (auth, payments, secrets, permissions) require explicit owner approval.\n` },
  { key: "missing-editorconfig", kind: "repair", priority: 40, path: ".editorconfig", title: "Add .editorconfig for consistent formatting",
    summary: "No .editorconfig found; editors may mix indentation and line endings.",
    content: () => `root = true\n\n[*]\ncharset = utf-8\nend_of_line = lf\nindent_style = space\nindent_size = 2\ninsert_final_newline = true\ntrim_trailing_whitespace = true\n` },
  { key: "missing-readme", kind: "docs", priority: 60, path: "README.md", title: "Add a README",
    summary: "No README.md; new contributors and agents have no entry point describing the project.",
    content: (repo) => `# ${repo.split("/")[1]}\n\nPrivate project. See SECURITY.md for reporting issues.\n\n## Development\n\n\`\`\`\nbun install\nbun run dev\nbun run test\n\`\`\`\n` },
  { key: "missing-gitignore", kind: "repair", priority: 65, path: ".gitignore", title: "Add .gitignore to keep secrets and builds out of git",
    summary: "No .gitignore; environment files, dependencies or build output could be committed by mistake.",
    content: () => `node_modules/\ndist/\n.output/\n.env\n.env.*\n!.env.example\n*.log\n.DS_Store\n` },
];

export async function inspectProject(projectId: string, actor: string, source: "manual" | "scheduled", limit = 1) {
  const { data: p } = await supabaseAdmin.from("owner_projects").select("id, name, github_repo").eq("id", projectId).single();
  if (!p) throw new Error("Project not found.");
  if (!p.github_repo) { await event({ id: null as never, project_id: p.id }, "inspect_blocked", actor, null, null, "No GitHub repo linked."); return { created: 0, blocked: "No GitHub repo linked to this project." }; }
  const { data: rg } = await supabaseAdmin.from("capability_grants").select("status, paused").eq("capability", "github_repo").eq("project_id", p.id).maybeSingle();
  if (rg && (rg.status === "revoked" || rg.paused)) { await event({ id: null as never, project_id: p.id }, "inspect_blocked", actor, null, null, "GitHub repo access revoked or paused in AutoConnect."); return { created: 0, blocked: "GitHub repo access is revoked or paused for this project." }; }
  let repo: ws.Repo;
  try { repo = await ws.openRepo(p.github_repo); }
  catch (e) { const m = (e as Error).message; await event({ id: null as never, project_id: p.id }, "inspect_blocked", actor, null, null, m); return { created: 0, blocked: m }; }
  const t = await ws.tree(repo, repo.base);
  const have = new Set(t.files);
  const found = CHECKS.filter((c) => !have.has(c.path)).sort((a, b) => b.priority - a.priority);
  let created = 0; const ids: string[] = [];
  for (const c of found) {
    if (created >= limit) break;
    const { data: existing } = await supabaseAdmin.from("foundry_tasks").select("id").eq("project_id", p.id).eq("dedupe_key", c.key).maybeSingle();
    if (existing) continue; // dedupe: never re-propose the same finding
    const { data: row, error } = await supabaseAdmin.from("foundry_tasks").insert({
      project_id: p.id, title: c.title, summary: c.summary, kind: c.kind, dedupe_key: c.key, repo: repo.full, source,
      priority: c.priority, risk: classifyRisk([{ path: c.path }]), files: [{ path: c.path, action: "create" }] as never,
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
  let scan: Awaited<ReturnType<typeof codeScan>> | null = null;
  if (created < limit) {
    scan = await codeScan(p.id, repo, t.files, actor, source).catch(async (e) => { const m = (e as Error).message; await event({ id: null as never, project_id: p.id }, "code_scan_failed", actor, null, null, m); return { error: m } as never; });
    if (scan && "taskId" in scan && scan.taskId) { created++; ids.push(scan.taskId); }
  }
  return { created, ids, inspectedFiles: t.total, findings: found.length, scan };
}

/** Source-code defect scan → AI fix → deterministic validation → branch commit → update package → (routine only) draft PR. */
async function codeScan(projectId: string, repo: ws.Repo, files: string[], actor: string, source: "manual" | "scheduled") {
  const cs = await import("./code-scan");
  const targets = files.filter(cs.scannable).slice(0, 300); // bounded: at most 300 file reads per run
  const defects: import("./code-scan").Defect[] = [];
  const contents = new Map<string, { content: string; sha: string }>();
  for (const path of targets) {
    try { const f = await ws.read(repo, path, repo.base); contents.set(path, f); defects.push(...cs.scanFile(path, f.content)); } catch { /* unreadable/protected files are skipped */ }
  }
  await event({ id: null as never, project_id: projectId }, "code_scan", actor, null, null, `Scanned ${contents.size} source file(s) in ${repo.full}; ${defects.length} finding(s).`, { scanned: contents.size, findings: defects.length, rules: [...new Set(defects.map((d) => d.rule))] });
  let pick: import("./code-scan").Defect | undefined;
  for (const d of cs.prioritize(defects)) {
    const { data: ex } = await supabaseAdmin.from("foundry_tasks").select("id").eq("project_id", projectId).eq("dedupe_key", cs.dedupeKey(d)).maybeSingle();
    if (!ex) { pick = d; break; }
  }
  if (!pick) return { scanned: contents.size, findings: defects.length, taskId: null as string | null, note: "No new findings." };
  const d = pick;
  const risk = d.risk === "sensitive" || classifyRisk([{ path: d.path }]) === "sensitive" ? "sensitive" : "low";
  const { data: row, error } = await supabaseAdmin.from("foundry_tasks").insert({
    project_id: projectId, title: `${d.title} in ${d.path}:${d.line}`, summary: `${d.why} Line ${d.line}: ${d.excerpt}`, kind: "repair", dedupe_key: cs.dedupeKey(d), repo: repo.full, source,
    priority: risk === "low" ? 55 : 80, risk, files: [{ path: d.path, action: "update" }] as never,
  }).select("*").single();
  if (error || !row) throw new Error(error?.message ?? "Could not create task.");
  const task = row as unknown as Task;
  await event(task, "discovered", actor, null, "discovered", `${d.rule} at ${d.path}:${d.line}`, { rule: d.rule });
  try {
    await move(task, "analyzing", actor, "Generating a minimal fix with AI.");
    if (risk !== "low") { await move(task, "blocked", actor, "Sensitive finding: Jackboy does not auto-generate fixes here. Owner review required.", { blocked_reason: "Sensitive finding — owner review required.", next_attempt_at: null }); return { scanned: contents.size, findings: defects.length, taskId: task.id }; }
    const before = contents.get(d.path)!;
    const after = cs.extractCode(await generateFix(d, before.content));
    const v = cs.validateFix(d, before.content, after);
    if (!v.ok) { await move(task, "failed", actor, `Generated fix rejected by validation: ${v.checks.filter((c) => !c.passed).map((c) => c.detail).join(" ")}`, { test_evidence: { status: "failed", validation: v } }); return { scanned: contents.size, findings: defects.length, taskId: task.id }; }
    const branch = `jackboy/scan-${d.rule}-${task.id.slice(0, 8)}`;
    const w = await ws.write(repo, branch, d.path, after, d.title);
    await move(task, "patch_prepared", actor, `Committed AI fix to ${d.path} on ${branch}.`, { branch, commit_sha: w.commit });
    await move(task, "testing", actor, "Validation passed; reading CI checks.");
    const ck = await ws.checks(repo, branch);
    const ci = "error" in ck && ck.error ? { status: "not_runnable", reason: ck.error } : !ck.workflowsConfigured ? { status: "not_runnable", reason: "No CI workflows on this repo and no sandbox runner." } : !ck.runs.length ? { status: "pending" } : { status: ck.runs.every((r) => r.conclusion === "success") ? "passed" : ck.runs.some((r) => r.conclusion === "failure") ? "failed" : "pending" };
    const dd = await ws.diff(repo, branch);
    const evidence = { status: ci.status === "failed" ? "failed" : "static_passed", validation: v, ci };
    await move(task, "awaiting_approval", actor, `Static validation passed (${v.checks.length} checks); CI: ${ci.status}.`, { test_evidence: evidence, needs_capability: ci.status === "not_runnable" ? capabilityForTestGap(String((ci as { reason?: string }).reason ?? "")) : null, files: dd.files.map((f) => ({ path: f.file, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch })) });
    // Versioned, checksummed, immutable update package with rollback plan.
    const sha = async (x: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const c = cs.lineChanges(before.content, after);
    const { count } = await supabaseAdmin.from("foundry_packages").select("id", { count: "exact", head: true }).eq("project_id", projectId);
    const pkg: import("./code-scan").UpdatePackage = {
      schema: "jackboy.update-package/v1", version: cs.packageVersion(new Date(), (count ?? 0) + 1), repo: repo.full, branch, base: repo.base, base_commit: null, commit: w.commit,
      finding: { rule: d.rule, path: d.path, line: d.line, title: d.title, why: d.why, risk: d.risk },
      files: [{ path: d.path, before_sha256: await sha(before.content), after_sha256: await sha(after), added: c.added, removed: c.removed }],
      tests: { ...v, ci }, rollback: { strategy: "restore_previous_content", files: [{ path: d.path, restore_sha256: await sha(before.content) }], note: `Close the draft PR, or restore ${d.path} to blob ${before.sha} from ${repo.base}. Nothing is merged or deployed by Jackboy.` },
      diff: dd.files.map((f) => `--- ${f.file}\n${f.patch}`).join("\n"),
    };
    pkg.package_sha256 = await sha(cs.canonical(pkg));
    const ins = await supabaseAdmin.from("foundry_packages").insert({ task_id: task.id, project_id: projectId, version: pkg.version, package_sha256: pkg.package_sha256, manifest: pkg as never });
    if (ins.error) throw new Error(`Package not stored: ${ins.error.message}`);
    await event(task, "package_built", actor, null, null, `Update package ${pkg.version} sha256 ${pkg.package_sha256.slice(0, 12)}…`, { version: pkg.version, sha256: pkg.package_sha256 });
    if (ci.status !== "failed" && cs.autoRunnable(d, v, dd.files.length)) {
      await move(task, "approved", "policy:routine-auto", "Routine low-risk single-file fix: draft PR allowed by policy (never merge/deploy).", { approved_action: "open_draft_pr" });
      await execute(task.id, "policy:routine-auto");
    }
  } catch (e) {
    const m = (e as Error).message.slice(0, 500);
    const cur = await load(task.id);
    if (["analyzing", "patch_prepared", "testing"].includes(cur.state)) await move(cur, "blocked", actor, m, { blocked_reason: m, next_attempt_at: null }).catch(() => {});
  }
  return { scanned: contents.size, findings: defects.length, taskId: task.id };
}

async function generateFix(d: import("./code-scan").Defect, content: string): Promise<string> {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new Error("AI is not configured (LOVABLE_API_KEY missing).");
  const { createOpenAI } = await import("@ai-sdk/openai");
  const { streamText } = await import("ai");
  const provider = createOpenAI({ baseURL: "https://ai.gateway.lovable.dev/v1", apiKey: key, headers: { "Lovable-API-Key": key, "X-Lovable-AIG-SDK": "vercel-ai-sdk" } });
  const r = streamText({
    model: provider.responses("openai/gpt-6-astra"),
    instructions: "You fix exactly one defect in a source file with the smallest possible change. Return the COMPLETE corrected file in one fenced code block and nothing else. Do not reformat, rename or touch any other line.",
    prompt: `Defect: ${d.title} (rule ${d.rule}) at line ${d.line}.\nWhy: ${d.why}\nFile ${d.path}:\n\`\`\`\n${content}\n\`\`\``,
    providerOptions: { openai: { store: false, forceReasoning: true, reasoningEffort: "low", reasoningSummary: "auto", include: ["reasoning.encrypted_content"] } },
  });
  return await r.text;
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
  await move(task, "awaiting_approval", actor, `Tests: ${String(evidence["status"])}. Waiting for owner.`, { test_evidence: evidence, needs_capability: evidence["status"] === "not_runnable" ? capabilityForTestGap(String(evidence["reason"] ?? "")) : null, files: d.files.map((f) => ({ path: f.file, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch })) });
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
    if (isTransient(msg) && t.attempts < t.max_attempts) {
      const at = new Date(Date.now() + backoffMs(t.attempts)).toISOString();
      await move(t, "blocked", actor, `Temporary error; automatic retry after ${at}. ${msg}`, { blocked_reason: msg, next_attempt_at: at });
    } else if (/not connected|missing|401|403|Refused/i.test(msg)) await move(t, "blocked", actor, msg, { blocked_reason: msg, next_attempt_at: null });
    else await move(t, "failed", actor, msg, { blocked_reason: msg });
  }
  const done = await load(id);
  if (done.state === "completed") await advance(actor).catch(() => {});
  return done;
}

/** After a completion: report the next task, or inspect the next authorized project within budget. */
export async function advance(actor: string) {
  const { data: waiting } = await supabaseAdmin.from("foundry_tasks").select("id, title").eq("state", "awaiting_approval").eq("paused", false).order("priority", { ascending: false }).order("created_at").limit(1);
  if (waiting?.[0]) { await event(null, "next_task", actor, null, null, `Next: ${waiting[0].title} (awaiting approval)`); return { next: waiting[0].id }; }
  const r = await runBudgeted(actor, "advance");
  return r;
}

/** One bounded inspection of the next project in rotation, charged to the daily budget. */
async function runBudgeted(actor: string, why: string) {
  const { data: s } = await supabaseAdmin.from("foundry_schedule").select("*").eq("id", 1).single();
  if (!s) return { skipped: "no schedule row" };
  if (s.paused) return { skipped: "paused" };
  const today = new Date().toISOString().slice(0, 10);
  const b = budget(s, today);
  if (!b.allowed) return { skipped: "daily run budget reached" };
  const { count: inflight } = await supabaseAdmin.from("foundry_tasks").select("id", { count: "exact", head: true }).in("state", IN_FLIGHT);
  if ((inflight ?? 0) >= s.max_in_flight) return { skipped: "concurrency limit" };
  const since = new Date(Date.now() - 86400_000).toISOString();
  const { count } = await supabaseAdmin.from("foundry_tasks").select("id", { count: "exact", head: true }).neq("source", "manual").gte("created_at", since);
  const left = quotaLeft(s.daily_task_quota, count ?? 0);
  if (left === 0) return { skipped: "daily task quota reached" };
  const { data: projects } = await supabaseAdmin.from("owner_projects").select("id").eq("active", true).eq("dev_enabled", true).not("github_repo", "is", null).order("dev_priority").order("name"); // only owner-activated projects, OMNI → JAX → Nano → Jail Release → rest
  const p = nextProject(projects ?? [], s.last_project_id);
  if (!p) return { skipped: "no authorized projects with a linked repo" };
  await supabaseAdmin.from("foundry_schedule").update({ last_project_id: p.id, runs_today: b.runsToday + 1, runs_day: today }).eq("id", 1);
  const r = await inspectProject(p.id, actor, "scheduled", 1);
  await event(null, "auto_inspect", actor, null, null, `${why}: inspected next project`, r as Record<string, unknown>);
  return r;
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

/** Hourly tick: retries due blocked tasks (backoff), then one budgeted inspection when due. Never approves anything. */
export async function foundryTick() {
  const { data: s } = await supabaseAdmin.from("foundry_schedule").select("*").eq("id", 1).single();
  const result: Record<string, unknown> = {};
  if (!s) return { skipped: "no schedule row" };
  if (s.paused) result["skipped"] = "paused";
  else {
    const { data: due } = await supabaseAdmin.from("foundry_tasks").select("id").eq("state", "blocked").eq("paused", false).not("approved_action", "is", null).not("next_attempt_at", "is", null).lte("next_attempt_at", new Date().toISOString()).limit(2);
    const retried: string[] = [];
    for (const d of due ?? []) { try { await retryBlocked(d.id, "scheduler"); retried.push(d.id); } catch { /* recorded in events */ } }
    result["retried"] = retried.length;
    if (!s.enabled) result["inspect"] = "recurring inspections off";
    else if (s.last_run_at && Date.now() - new Date(s.last_run_at).getTime() < s.interval_hours * 3600_000) result["inspect"] = "not due";
    else { await supabaseAdmin.from("foundry_schedule").update({ last_run_at: new Date().toISOString() }).eq("id", 1); result["inspect"] = await runBudgeted("scheduler", "scheduled"); }
  }
  await supabaseAdmin.from("foundry_schedule").update({ last_tick_at: new Date().toISOString(), last_tick_result: result as never }).eq("id", 1);
  return result;
}

/** Webhook-triggered scan for a pushed private repo (signature verified by the route). */
export async function webhookInspect(repoFull: string) {
  const { data: p } = await supabaseAdmin.from("owner_projects").select("id").eq("active", true).eq("dev_enabled", true).ilike("github_repo", repoFull).maybeSingle();
  if (!p) return { skipped: "repo not registered" };
  return runBudgetedFor(p.id);
}
async function runBudgetedFor(projectId: string) {
  const { data: s } = await supabaseAdmin.from("foundry_schedule").select("*").eq("id", 1).single();
  if (!s || s.paused) return { skipped: "paused" };
  const today = new Date().toISOString().slice(0, 10);
  const b = budget(s, today);
  if (!b.allowed) return { skipped: "daily run budget reached" };
  await supabaseAdmin.from("foundry_schedule").update({ runs_today: b.runsToday + 1, runs_day: today }).eq("id", 1);
  const r = await inspectProject(projectId, "webhook", "scheduled", 1);
  await event({ id: null as never, project_id: projectId }, "webhook_inspect", "webhook", null, null, "Push webhook triggered inspection", r as Record<string, unknown>);
  return r;
}

export async function setGlobalPause(actor: string, paused: boolean) {
  await supabaseAdmin.from("foundry_schedule").update({ paused, updated_at: new Date().toISOString() }).eq("id", 1);
  await event(null, paused ? "global_pause" : "global_resume", actor, null, null);
}

export async function setSchedule(actor: string, v: { enabled: boolean; interval_hours: number; daily_task_quota: number; max_in_flight: number; max_runs_per_day: number }) {
  await supabaseAdmin.from("foundry_schedule").update({ ...v, updated_at: new Date().toISOString() }).eq("id", 1);
  await event(null, "schedule_changed", actor, null, null, "", v);
}

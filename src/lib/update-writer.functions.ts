import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { canMerge, canTransition, FREQUENCY_HOURS, monthStart, parseRepo, STATUSES, type ProposalStatus } from "./update-writer";
import { safeFetchUrl, sha256Hex } from "./feeds";

type Ctx = { supabase: any; userId: string };
async function owner(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Owner only.");
}
const audit = (ctx: Ctx, action: string, detail: Record<string, unknown>, outcome = "ok") =>
  ctx.supabase.rpc("write_audit", { _action: action, _detail: detail, _outcome: outcome });
const freq = z.number().int().refine((h) => FREQUENCY_HOURS.includes(h), "Invalid frequency");

// ---------- Projects ----------
const projectInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  lovable_url: z.string().trim().max(500).refine((v) => !v || /^https:\/\//.test(v), "Link must start with https://"),
  description: z.string().trim().max(2000),
  goals: z.string().trim().max(4000),
  notes: z.string().trim().max(8000),
  github_repo: z.string().trim().max(201).refine((v) => !v || parseRepo(v) !== null, "Repo must look like owner/repo"),
  github_branch: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._/-]+$/),
  frequency_hours: freq,
  active: z.boolean(),
  site_url: z.string().trim().max(500).refine((v) => !v || /^https?:\/\//.test(v), "Site URL must start with https://").optional(),
});
export type ProjectRow = { id: string; name: string; lovable_url: string | null; description: string; goals: string; notes: string; github_repo: string | null; github_branch: string; frequency_hours: number; active: boolean; last_proposal_at: string | null; site_url: string | null; autopilot: boolean; connect_state: string; connect_pr_url: string | null; connect_error: string | null };

export const getProjects = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  await owner(context);
  const { data, error } = await context.supabase.from("owner_projects").select("*").order("name");
  if (error) throw new Error(error.message);
  return { projects: data as ProjectRow[], githubConfigured: Boolean(process.env["GITHUB_TOKEN"]) };
});

export const saveProject = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => projectInput.parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const row = { name: data.name, lovable_url: data.lovable_url || null, description: data.description, goals: data.goals, notes: data.notes, github_repo: data.github_repo || null, github_branch: data.github_branch, frequency_hours: data.frequency_hours, active: data.active, site_url: data.site_url || null, updated_at: new Date().toISOString() };
    const res = data.id
      ? await context.supabase.from("owner_projects").update(row).eq("id", data.id)
      : await context.supabase.from("owner_projects").insert({ ...row, created_by: context.userId }).select("id").single();
    if (res.error) throw new Error(res.error.message);
    await audit(context, data.id ? "projects.update" : "projects.create", { name: data.name, repo: data.github_repo || null });
    return { ok: true, id: (data.id ?? (res.data as { id: string }).id) as string, created: !data.id };
  });

export const deleteProject = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { error } = await context.supabase.from("owner_projects").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    await audit(context, "projects.delete", { id: data.id });
    return { ok: true };
  });

/** Checks the token can see the repo and that it is private. Read-only. */
export const testRepo = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ repo: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const r = parseRepo(data.repo);
    if (!r) return { ok: false, message: "Repo must look like owner/repo." };
    const gh = await import("./github.server");
    try { const info = await gh.requirePrivateRepo(r.owner, r.repo); return { ok: true, message: `Private repo reachable. Default branch: ${info.default_branch}.${info.permissions?.push ? "" : " Token cannot push — PRs will fail."}` }; }
    catch (e) { return { ok: false, message: (e as Error).message }; }
  });

// ---------- Queue ----------
type FileRow = { path: string; content: string; previous?: string | null };
export const getQueue = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  await owner(context);
  const ms = monthStart();
  const [p, s, l, n, ai, runs] = await Promise.all([
    context.supabase.from("update_proposals").select("*, owner_projects(name, lovable_url, github_repo)").order("created_at", { ascending: false }).limit(200),
    context.supabase.from("update_writer_settings").select("last_run_at, paused_reason, monthly_ai_cap, monthly_run_cap").eq("id", 1).single(),
    context.supabase.from("audit_logs").select("id, at, action, outcome, detail").or("action.like.updates.%,action.like.projects.%,action.like.feeds.%").order("at", { ascending: false }).limit(40),
    context.supabase.from("owner_notifications").select("*").order("created_at", { ascending: false }).limit(20),
    context.supabase.from("usage_ledger").select("id", { count: "exact", head: true }).eq("kind", "ai").gte("at", ms),
    context.supabase.from("usage_ledger").select("id", { count: "exact", head: true }).eq("kind", "run").gte("at", ms),
  ]);
  return {
    proposals: (p.data ?? []).map((x: any) => ({ ...x, files: (x.files ?? []).map((f: FileRow) => ({ path: f.path, content: f.content, isNew: f.previous === null })) })) as Array<{ id: string; status: ProposalStatus; title: string; what_to_change: string; why: string; build_prompt: string; trigger: string; edited: boolean; created_at: string; files: { path: string; content: string; isNew: boolean }[]; pr_url: string | null; pr_number: number | null; checks_state: string | null; delivery_error: string | null; revert_pr_url: string | null; owner_projects: { name: string; lovable_url: string | null; github_repo: string | null } | null }>,
    settings: s.data as { last_run_at: string | null; paused_reason: string | null; monthly_ai_cap: number; monthly_run_cap: number } | null,
    usage: { ai: ai.count ?? 0, runs: runs.count ?? 0 },
    notifications: (n.data ?? []) as Array<{ id: string; kind: string; message: string; read: boolean; email_state: string; created_at: string }>,
    log: (l.data ?? []) as Array<{ id: string; at: string; action: string; outcome: string; detail: { name?: string; title?: string; error?: string } }>,
    githubConfigured: Boolean(process.env["GITHUB_TOKEN"]),
  };
});

export const editProposal = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), title: z.string().trim().min(1).max(200), what_to_change: z.string().trim().min(1).max(4000), why: z.string().trim().min(1).max(3000), build_prompt: z.string().trim().min(1).max(12000) }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { id, ...rest } = data;
    const { data: cur } = await context.supabase.from("update_proposals").select("status").eq("id", id).single();
    if (!cur || !["draft", "approved", "rejected"].includes(cur.status)) throw new Error("Only drafts can be edited (code already in a PR is edited on GitHub).");
    const { error } = await context.supabase.from("update_proposals").update({ ...rest, edited: true }).eq("id", id);
    if (error) throw new Error(error.message);
    await audit(context, "updates.edit", { id, title: data.title });
    return { ok: true };
  });

export const setProposalStatus = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), status: z.enum(STATUSES) }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { data: cur } = await context.supabase.from("update_proposals").select("status, title").eq("id", data.id).single();
    if (!cur) throw new Error("Proposal not found.");
    if (!canTransition(cur.status as ProposalStatus, data.status)) throw new Error(`Can't move from ${cur.status} to ${data.status}.`);
    if (data.status === "rejected") { const s = await import("./update-writer.server"); await s.rejectProposal(data.id, context.userId); return { ok: true }; }
    const { error } = await context.supabase.from("update_proposals").update({ status: data.status, decided_by: context.userId, decided_at: new Date().toISOString() }).eq("id", data.id);
    if (error) throw new Error(error.message);
    await audit(context, `updates.${data.status}`, { id: data.id, title: cur.title, from: cur.status });
    return { ok: true };
  });

const idOnly = (d: unknown) => z.object({ id: z.string().uuid() }).parse(d);

export const openPr = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator(idOnly)
  .handler(async ({ data, context }) => { await owner(context); const s = await import("./update-writer.server"); await s.deliver(data.id, context.userId); return { ok: true }; });

export const refreshPrChecks = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator(idOnly)
  .handler(async ({ data, context }) => { await owner(context); const s = await import("./update-writer.server"); return { state: await s.refreshChecks(data.id) }; });

export const mergeUpdate = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), acceptNoChecks: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const s = await import("./update-writer.server");
    const state = await s.refreshChecks(data.id);
    const { data: cur } = await context.supabase.from("update_proposals").select("status").eq("id", data.id).single();
    const gate = canMerge((cur?.status ?? "draft") as ProposalStatus, state, data.acceptNoChecks);
    if (!gate.ok) { await audit(context, "updates.merge_blocked", { id: data.id, reason: gate.reason }, "denied"); throw new Error(gate.reason); }
    await s.mergeProposal(data.id, context.userId);
    return { ok: true };
  });

export const revertUpdate = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator(idOnly)
  .handler(async ({ data, context }) => { await owner(context); const s = await import("./update-writer.server"); await s.revertProposal(data.id, context.userId); return { ok: true }; });

export const setCaps = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ aiCap: z.number().int().min(0).max(10000), runCap: z.number().int().min(0).max(10000), clearPause: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const patch: { monthly_ai_cap: number; monthly_run_cap: number; updated_at: string; paused_reason?: null } = { monthly_ai_cap: data.aiCap, monthly_run_cap: data.runCap, updated_at: new Date().toISOString() };
    if (data.clearPause) patch.paused_reason = null;
    const { error } = await context.supabase.from("update_writer_settings").update(patch).eq("id", 1);
    if (error) throw new Error(error.message);
    await audit(context, "updates.caps", { aiCap: data.aiCap, runCap: data.runCap, resumed: data.clearPause });
    return { ok: true };
  });

export const markNotificationsRead = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  await owner(context);
  await context.supabase.from("owner_notifications").update({ read: true }).eq("read", false);
  return { ok: true };
});

export const runNow = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ projectId: z.string().uuid().optional() }).parse(d ?? {}))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { runUpdateWriter } = await import("./update-writer.server");
    return runUpdateWriter({ trigger: "manual", actor: context.userId, ...(data.projectId ? { projectId: data.projectId } : {}) });
  });

// ---------- Feeds ----------
export const getFeeds = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  await owner(context);
  const [s, i, p] = await Promise.all([
    context.supabase.from("feed_sources").select("id, kind, name, url, project_ids, active, last_checked_at, last_error, created_at").order("created_at"),
    context.supabase.from("feed_items").select("id, source_id, title, url, summary, published_at, project_ids, created_at").order("created_at", { ascending: false }).limit(100),
    context.supabase.from("owner_projects").select("id, name").order("name"),
  ]);
  return {
    sources: (s.data ?? []) as Array<{ id: string; kind: "rss" | "page" | "webhook"; name: string; url: string | null; project_ids: string[]; active: boolean; last_checked_at: string | null; last_error: string | null }>,
    items: (i.data ?? []) as Array<{ id: string; source_id: string; title: string; url: string | null; summary: string; published_at: string | null; project_ids: string[]; created_at: string }>,
    projects: (p.data ?? []) as Array<{ id: string; name: string }>,
  };
});

export const addFeed = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ kind: z.enum(["rss", "page", "webhook"]), name: z.string().trim().min(1).max(120), url: z.string().trim().max(500), projectIds: z.array(z.string().uuid()).max(50) }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    if (data.kind !== "webhook" && !safeFetchUrl(data.url)) throw new Error("Enter a public http(s) URL.");
    let token: string | null = null;
    if (data.kind === "webhook") { const b = crypto.getRandomValues(new Uint8Array(24)); token = "jbw_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); }
    const { data: row, error } = await context.supabase.from("feed_sources").insert({ kind: data.kind, name: data.name, url: data.kind === "webhook" ? null : data.url, project_ids: data.projectIds, token_hash: token ? await sha256Hex(token) : null, created_by: context.userId }).select("id").single();
    if (error) throw new Error(error.message);
    await audit(context, "feeds.add", { name: data.name, kind: data.kind });
    return { id: row.id as string, token }; // token shown once; only its hash is stored
  });

export const updateFeed = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), active: z.boolean().optional(), projectIds: z.array(z.string().uuid()).max(50).optional(), remove: z.boolean().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const q = context.supabase.from("feed_sources");
    const { error } = data.remove ? await q.delete().eq("id", data.id) : await q.update({ ...(data.active !== undefined ? { active: data.active } : {}), ...(data.projectIds ? { project_ids: data.projectIds } : {}) }).eq("id", data.id);
    if (error) throw new Error(error.message);
    await audit(context, data.remove ? "feeds.remove" : "feeds.update", { id: data.id });
    return { ok: true };
  });

export const tagItem = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), projectIds: z.array(z.string().uuid()).max(50) }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { error } = await context.supabase.from("feed_items").update({ project_ids: data.projectIds }).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const checkFeedsNow = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  await owner(context);
  const s = await import("./update-writer.server");
  const added = await s.pollFeeds();
  await audit(context, "feeds.poll", { added });
  return { added };
});

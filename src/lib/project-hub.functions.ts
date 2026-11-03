import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Ctx = { supabase: any; userId: string };
async function owner(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Owner only.");
}

export type HubRow = { id: string; name: string; site_url: string | null; lovable_url: string | null; github_repo: string | null; repo_sync_status?: string; github_branch: string; autopilot: boolean; connect_state: string; connect_error: string | null; description: string; goals: string; notes: string; frequency_hours: number; active: boolean; connect_pr_url: string | null; site_status: string; site_checked_at: string | null; site_evidence: { reason?: string; url?: string; dns?: { ok: boolean; addresses: string[]; error?: string }; http?: { status?: number; ms?: number; finalUrl?: string; error?: string } | null }; site_monitoring: boolean };
export type RepoCheck = { repo: string; checkedAt: string; exists: boolean; read: string; prWrite: string };
export type HubScanRow = { id: string; project_id: string; status: string; trigger: string; pages_checked: number; links_checked: number; avg_ms: number | null; findings: { severity: string; kind: string; url: string; message: string }[]; error: string | null; fix_proposal_id: string | null; created_at: string };
export type HubProposal = { id: string; project_id: string; title: string; status: string; source: string; pr_url: string | null; checks_state: string | null; created_at: string; delivery_error?: string | null; has_files?: boolean; has_repo?: boolean };

/** Owner-only overview: connected projects, latest scans, waiting approvals and the stored Lovable inventory snapshot. */
export const getProjectHub = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  await owner(context);
  const [p, s, q, inv, chk] = await Promise.all([
    context.supabase.from("owner_projects").select("*").order("name"),
    context.supabase.from("site_scans").select("id,project_id,status,trigger,pages_checked,links_checked,avg_ms,findings,error,fix_proposal_id,created_at").order("created_at", { ascending: false }).limit(200),
    context.supabase.from("update_proposals").select("id,project_id,title,status,source,pr_url,checks_state,delivery_error,files,created_at,owner_projects(github_repo)").in("status", ["draft", "pr_open", "approved"]).order("created_at", { ascending: false }).limit(200),
    context.supabase.from("agent_projects").select("id,name,lovable_project_ref").order("name"),
    context.supabase.from("project_github_checks").select("project_id,repo,checked_at,evidence"),
  ]);
  for (const r of [p, s, q, inv]) if (r.error) throw new Error(r.error.message);
  const statuses = await (await import("./repository-resync.server")).repositoryDriftStatuses(context.userId);
  return {
    projects: (p.data ?? []).filter((r) => r.active !== false).map((r) => ({ ...r, repo_sync_status: r.github_repo ? statuses[r.github_repo.toLowerCase()] : undefined })) as HubRow[],
    archived: (p.data ?? []).filter((r) => r.active === false).map((r) => ({ id: r.id as string, name: r.name as string, github_repo: r.github_repo as string | null })),
    scans: (s.data ?? []) as HubScanRow[],
    waiting: ((q.data ?? []) as (HubProposal & { files: unknown[]; owner_projects: { github_repo: string | null } | null })[]).map(({ files, owner_projects, ...r }) => ({ ...r, has_files: Array.isArray(files) && files.length > 0, has_repo: Boolean(owner_projects?.github_repo) })),
    checks: Object.fromEntries(((chk.data ?? []) as { project_id: string; repo: string; checked_at: string; evidence: { exists?: boolean; contentsRead?: { state: string }; pullRequestsWrite?: { state: string } } }[])
      .map((c) => [c.project_id, { repo: c.repo, checkedAt: c.checked_at, exists: c.evidence?.exists !== false, read: c.evidence?.contentsRead?.state ?? "unknown", prWrite: c.evidence?.pullRequestsWrite?.state ?? "unknown" }])) as Record<string, RepoCheck>,
    inventory: (inv.data ?? []) as { id: string; name: string; lovable_project_ref: string | null }[],
    githubConfigured: Boolean(process.env["GITHUB_TOKEN"]),
    lovableApiLinked: Boolean(process.env["LOVABLE_ACCOUNT_API_KEY"]),
  };
});

export const getProjectDetail = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const [p, s, q] = await Promise.all([
      context.supabase.from("owner_projects").select("*").eq("id", data.id).maybeSingle(),
      context.supabase.from("site_scans").select("id,project_id,status,trigger,pages_checked,links_checked,avg_ms,findings,error,fix_proposal_id,created_at").eq("project_id", data.id).order("created_at", { ascending: false }).limit(10),
      context.supabase.from("update_proposals").select("id,project_id,title,status,source,pr_url,checks_state,created_at").eq("project_id", data.id).order("created_at", { ascending: false }).limit(30),
    ]);
    for (const r of [p, s, q]) if (r.error) throw new Error(r.error.message);
    const statuses = await (await import("./repository-resync.server")).repositoryDriftStatuses(context.userId);
    if (p.data?.github_repo) Object.assign(p.data, { repo_sync_status: statuses[p.data.github_repo.toLowerCase()] });
    return { project: (p.data ?? null) as HubRow | null, scans: (s.data ?? []) as HubScanRow[], proposals: (q.data ?? []) as HubProposal[], githubConfigured: Boolean(process.env["GITHUB_TOKEN"]) };
  });

export type Decision = { finding_key: string; decision: "ignored" | "remove_demo" | "repair"; proposal_id: string | null; created_at: string };

export const getDecisions = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const [d, p] = await Promise.all([
      context.supabase.from("finding_decisions").select("finding_key,decision,proposal_id,created_at").eq("project_id", data.id),
      context.supabase.from("owner_projects").select("demo_detection,repair_policy").eq("id", data.id).maybeSingle(),
    ]);
    if (d.error) throw new Error(d.error.message);
    return { decisions: (d.data ?? []) as Decision[], demoDetection: p.data?.demo_detection !== false, repairPolicy: (p.data?.repair_policy ?? "autopilot") as "autopilot" | "approve" };
  });

/** Ignore / Remove Demo / Repair one finding. Remove Demo always goes to the approval queue (never auto-shipped). */
export const actOnFinding = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ scanId: z.string().uuid(), index: z.number().int().min(0).max(199), action: z.enum(["ignored", "remove_demo", "repair"]) }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { findingKey } = await import("./autopilot");
    const { data: scan } = await context.supabase.from("site_scans").select("project_id, findings").eq("id", data.scanId).single();
    const f = (scan?.findings as HubScanRow["findings"] | undefined)?.[data.index];
    if (!scan || !f) throw new Error("Finding not found.");
    if (data.action === "remove_demo" && f.kind !== "demo") throw new Error("Only demo findings can be removed as demo.");
    let proposalId: string | null = null; let note = "Ignored. You can undo this.";
    if (data.action !== "ignored") {
      const s = await import("./autopilot.server");
      const r = await s.writeFix(scan.project_id, `- [${f.severity}] ${f.kind} ${f.url}: ${f.message}`, data.action === "remove_demo" ? "demo" : "scan", context.userId, undefined, { forceApproval: data.action === "remove_demo" });
      proposalId = r.id; note = r.note;
    }
    const { error } = await context.supabase.from("finding_decisions").upsert({ project_id: scan.project_id, finding_key: findingKey(f), decision: data.action, proposal_id: proposalId, message: f.message.slice(0, 500), decided_by: context.userId }, { onConflict: "project_id,finding_key" });
    if (error) throw new Error(error.message);
    await context.supabase.rpc("write_audit", { _action: `findings.${data.action}`, _detail: { project: scan.project_id, kind: f.kind, url: f.url, proposal: proposalId }, _outcome: "ok" });
    return { note };
  });

export const undoDecision = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ projectId: z.string().uuid(), key: z.string().max(500) }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { error } = await context.supabase.from("finding_decisions").delete().eq("project_id", data.projectId).eq("finding_key", data.key).eq("decision", "ignored");
    if (error) throw new Error(error.message);
    await context.supabase.rpc("write_audit", { _action: "findings.unignore", _detail: { project: data.projectId }, _outcome: "ok" });
    return { ok: true };
  });

export const setProjectPrefs = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), demo_detection: z.boolean(), repair_policy: z.enum(["autopilot", "approve"]) }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { error } = await context.supabase.from("owner_projects").update({ demo_detection: data.demo_detection, repair_policy: data.repair_policy }).eq("id", data.id);
    if (error) throw new Error(error.message);
    await context.supabase.rpc("write_audit", { _action: "projects.prefs", _detail: data, _outcome: "ok" });
    return { ok: true };
  });

/** Owner explicitly activates/deactivates background development for ONE project. Audited. */
export const setDevEnabled = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), enabled: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { data: p, error } = await context.supabase.from("owner_projects").select("name").eq("id", data.id).single();
    if (error || !p) throw new Error("Project not found.");
    const { devPriority } = await import("./connect-select");
    const u = await context.supabase.from("owner_projects").update({ dev_enabled: data.enabled, dev_priority: devPriority(p.name) }).eq("id", data.id);
    if (u.error) throw new Error(u.error.message);
    await context.supabase.rpc("write_audit", { _action: data.enabled ? "dev.activate" : "dev.deactivate", _detail: { project: p.name }, _outcome: "ok" });
    const { logSite } = await import("./site-log.server");
    await logSite({ actor: `owner:${context.userId}`, action: data.enabled ? "dev.activate" : "dev.deactivate", category: "config", status: "info", summary: `${data.enabled ? "Activated" : "Deactivated"} background development for ${p.name}.`, project_id: data.id });
    return { ok: true };
  });

/** Owner saves a site address from the project card. Persists, audits, then runs a real DNS+HTTPS check. */
export const setSiteAddress = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), url: z.string().trim().min(1).max(500) }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { normalizeSiteInput } = await import("./project-hub");
    const url = normalizeSiteInput(data.url);
    if (!url) throw new Error("Enter a public https:// address, e.g. https://example.com");
    const { data: row, error } = await context.supabase.from("owner_projects").update({ site_url: url, site_status: "checking", site_fail_count: 0 }).eq("id", data.id).select("id,site_url,site_fail_count,site_status").single();
    if (error || !row) throw new Error(error?.message ?? "Project not found.");
    await context.supabase.rpc("write_audit", { _action: "projects.site_address", _detail: { id: data.id, url }, _outcome: "ok" });
    const { checkAndStore } = await import("./site-monitor.server");
    try {
      const c = await checkAndStore(context.supabase, row, context.userId);
      return { url, status: c.status as string, reason: (c.evidence.reason ?? null) as string | null, checkedAt: new Date().toISOString() };
    } catch (e) {
      return { url, status: "check_failed", reason: (e as Error).message, checkedAt: new Date().toISOString() };
    }
  });

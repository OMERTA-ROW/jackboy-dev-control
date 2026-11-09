import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database, Json } from "@/integrations/supabase/types";
import { hashProjectToken, newProjectToken } from "./agent-hub";

type Ctx = { supabase: SupabaseClient<Database>; userId: string };
async function role(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (!data) throw new Error("Forbidden: Jackboy access requires an accepted invitation.");
  return data as "owner" | "admin" | "member";
}
async function requireManager(ctx: Ctx) {
  const r = await role(ctx);
  if (r === "member") throw new Error("Forbidden: owner or admin only.");
  return r;
}
const audit = (ctx: Ctx, action: string, detail: Json, outcome = "ok") =>
  ctx.supabase.rpc("write_audit", { _action: action, _detail: detail, _outcome: outcome });

export const getHub = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const r = await role(context);
    const [p, q, pr] = await Promise.all([
      context.supabase.from("agent_projects").select("*").order("created_at"),
      context.supabase.from("agent_reports").select("*").in("status", ["open", "acknowledged"]).order("priority", { ascending: false }).order("created_at").limit(100),
      context.supabase.from("agent_proposals").select("*").order("created_at", { ascending: false }).limit(50),
    ]);
    for (const result of [p, q, pr]) {
      if (result.error) throw new Error(`Could not load Agent Hub data: ${result.error.message}`);
    }
    return { role: r, projects: p.data ?? [], queue: q.data ?? [], proposals: pr.data ?? [], omniConfigured: Boolean(process.env["OMNI_API_URL"] && process.env["OMNI_API_KEY"]) };
  });

export const addProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ name: z.string().trim().min(2).max(80), lovable_project_ref: z.string().trim().max(120).optional(), repo_url: z.string().url().max(300).optional().or(z.literal("")) }).parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { error } = await context.supabase.from("agent_projects").insert({ name: data.name, lovable_project_ref: data.lovable_project_ref || null, repo_url: data.repo_url || null, created_by: context.userId });
    if (error) throw new Error(error.message);
    await audit(context, "hub.project.add", { name: data.name });
    return { ok: true };
  });

export const updateProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), enrolled: z.boolean().optional(), angeltech_enabled: z.boolean().optional(), demontech_enabled: z.boolean().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const r = await requireManager(context);
    // Enabling security agents is a sensitive change: owner only.
    if (data.demontech_enabled === true && r !== "owner") throw new Error("Only the owner can authorize DemonTech checks.");
    const { id, ...rest } = data;
    const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as { enrolled?: boolean; angeltech_enabled?: boolean; demontech_enabled?: boolean };
    const { error } = await context.supabase.from("agent_projects").update(patch).eq("id", id);
    if (error) throw new Error(error.message);
    await audit(context, "hub.project.update", { id, ...patch });
    return { ok: true };
  });

/** Issues a project-scoped ingest token. Shown once; only the hash is stored. Owner only. */
export const issueToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    if ((await role(context)) !== "owner") throw new Error("Only the owner can issue agent credentials.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("agent_project_tokens").update({ revoked_at: new Date().toISOString() }).eq("project_id", data.projectId).is("revoked_at", null);
    const token = newProjectToken();
    const { error } = await supabaseAdmin.from("agent_project_tokens").insert({ project_id: data.projectId, token_hash: await hashProjectToken(token), created_by: context.userId });
    if (error) throw new Error("Could not issue token.");
    await audit(context, "hub.token.issue", { project: data.projectId, scope: "ingest:write" });
    return { token };
  });

export const revokeTokens = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    if ((await role(context)) !== "owner") throw new Error("Only the owner can revoke agent credentials.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("agent_project_tokens").update({ revoked_at: new Date().toISOString() }).eq("project_id", data.projectId).is("revoked_at", null);
    await audit(context, "hub.token.revoke", { project: data.projectId });
    return { ok: true };
  });

export const triageReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), status: z.enum(["acknowledged", "resolved", "dismissed"]) }).parse(d))
  .handler(async ({ data, context }) => {
    await requireManager(context);
    const { error } = await context.supabase.from("agent_reports").update({ status: data.status }).eq("id", data.id);
    if (error) throw new Error(error.message);
    await audit(context, "hub.report.triage", data);
    return { ok: true };
  });

export const createProposal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ projectId: z.string().uuid(), reportId: z.string().uuid().optional(), title: z.string().trim().min(3).max(200), summary: z.string().max(4000).default(""), action: z.enum(["merge", "deploy_production", "sensitive_change"]) }).parse(d))
  .handler(async ({ data, context }) => {
    await role(context);
    // tests_passed stays false: no isolated sandbox runner is connected yet, so nothing can claim passing tests.
    const { error } = await context.supabase.from("agent_proposals").insert({ project_id: data.projectId, report_id: data.reportId ?? null, title: data.title, summary: data.summary, action: data.action, sensitive: data.action !== "merge", created_by: context.userId });
    if (error) throw new Error(error.message);
    await audit(context, "hub.proposal.create", { project: data.projectId, action: data.action });
    return { ok: true };
  });

export const decideProposal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), approve: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("decide_proposal", { _id: data.id, _approve: data.approve });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

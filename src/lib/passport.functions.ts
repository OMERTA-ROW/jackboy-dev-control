import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Ctx = { supabase: any; userId: string };
async function role(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (!data) throw new Error("Forbidden: Jackboy access requires an accepted invitation.");
  return data as "owner" | "admin" | "member";
}
const audit = (ctx: Ctx, action: string, detail: Record<string, unknown>, outcome = "ok") =>
  ctx.supabase.rpc("write_audit", { _action: action, _detail: detail, _outcome: outcome });

/** OMNI has no verified authenticated API yet: jobs stay queued locally and are never marked sent. */
const OMNI_VERIFIED = false;

export const getPassport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const r = await role(context);
    const { data: agent } = await context.supabase.from("agents").select("*").eq("id", data.id).maybeSingle();
    if (!agent) throw new Error("Agent not found.");
    const [proj, reports, jobs, trail] = await Promise.all([
      context.supabase.from("agent_projects").select("id, name, enrolled").eq("id", agent.project_id).single(),
      context.supabase.from("agent_reports").select("*").eq("agent_id", agent.id).order("created_at", { ascending: false }).limit(50),
      context.supabase.from("omni_jobs").select("*").eq("project_id", agent.project_id).order("created_at", { ascending: false }).limit(20),
      context.supabase.from("audit_logs").select("*").contains("detail", { agent: agent.id }).order("at", { ascending: false }).limit(50),
    ]);
    return { role: r, agent, project: proj.data, reports: reports.data ?? [], jobs: jobs.data ?? [], trail: trail.data ?? [], omniVerified: OMNI_VERIFIED };
  });

export const updateModel = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), adapter: z.enum(["owner_agent", "third_party", "local"]), model_provider: z.string().trim().max(60), model_name: z.string().trim().max(80) }).parse(d))
  .handler(async ({ data, context }) => {
    if ((await role(context)) === "member") throw new Error("Owner or admin only.");
    const { id, ...patch } = data;
    const { error } = await context.supabase.from("agents").update(patch).eq("id", id);
    if (error) throw new Error(error.message);
    await audit(context, "agent.model", { agent: id, ...patch, note: "passport reset until owner re-approves" });
    return { ok: true };
  });

export const approvePassport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), approve: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("approve_passport", { _id: data.id, _approve: data.approve });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setJax = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), enroll: z.boolean(), purpose: z.string().max(500).default("") }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("set_jax_enrollment", { _id: data.id, _enroll: data.enroll, _purpose: data.purpose });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Jackboy queues a code/test job for OMNI from a prioritized report. Not transmitted until OMNI is verified. */
export const requestOmniJob = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ projectId: z.string().uuid(), reportId: z.string().uuid().optional(), kind: z.enum(["code", "test"]), instructions: z.string().trim().min(3).max(4000), agentId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    if ((await role(context)) === "member") throw new Error("Owner or admin only.");
    const { error } = await context.supabase.from("omni_jobs").insert({ project_id: data.projectId, report_id: data.reportId ?? null, kind: data.kind, instructions: data.instructions, created_by: context.userId });
    if (error) throw new Error(error.message);
    await audit(context, "omni.job.queue", { agent: data.agentId, project: data.projectId, kind: data.kind, sent: OMNI_VERIFIED }, OMNI_VERIFIED ? "ok" : "queued_not_sent");
    return { ok: true, sent: false };
  });

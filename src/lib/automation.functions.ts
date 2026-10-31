import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { LEARNING_KINDS, canDispatch, routeApproval } from "./automation-policy";

type Ctx = { supabase: any; userId: string };
async function role(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (!data) throw new Error("Forbidden: Jackboy access requires an accepted invitation.");
  return data as "owner" | "admin" | "member";
}
const audit = (ctx: Ctx, action: string, detail: Record<string, unknown>, outcome = "ok") =>
  ctx.supabase.rpc("write_audit", { _action: action, _detail: detail, _outcome: outcome });
// Neither OMNI nor Guardian has a verified authenticated API yet; these stay false until a real check passes.
const OMNI_VERIFIED = false;

export const getAutomation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const r = await role(context);
    const [pol, ev, pb, pj, log] = await Promise.all([
      context.supabase.from("automation_policy").select("*").eq("id", 1).single(),
      context.supabase.from("learning_events").select("*").order("created_at", { ascending: false }).limit(50),
      context.supabase.from("playbooks").select("*").order("created_at", { ascending: false }),
      context.supabase.from("agent_projects").select("id, name").order("name"),
      context.supabase.from("audit_logs").select("*").like("action", "automation.%").order("at", { ascending: false }).limit(30),
    ]);
    return { role: r, policy: pol.data, events: ev.data ?? [], playbooks: pb.data ?? [], projects: pj.data ?? [], decisions: log.data ?? [], omniVerified: OMNI_VERIFIED };
  });

export const setPolicy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ tier: z.number().int().min(0).max(2), paused: z.boolean(), maxFiles: z.number().int().min(1).max(20), maxLines: z.number().int().min(1).max(500) }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("set_automation_policy", { _tier: data.tier, _paused: data.paused, _max_files: data.maxFiles, _max_lines: data.maxLines });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const recordLearning = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ projectId: z.string().uuid(), kind: z.enum(LEARNING_KINDS), summary: z.string().trim().min(3).max(500), outcome: z.string().trim().max(40).default("recorded") }).parse(d))
  .handler(async ({ data, context }) => {
    await role(context);
    const { error } = await context.supabase.from("learning_events").insert({ project_id: data.projectId, kind: data.kind, summary: data.summary, outcome: data.outcome, created_by: context.userId });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const draftPlaybook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ title: z.string().trim().min(3).max(120), trigger: z.string().trim().min(3).max(200), steps: z.string().trim().min(3).max(4000) }).parse(d))
  .handler(async ({ data, context }) => {
    await role(context);
    const { error } = await context.supabase.from("playbooks").insert({ ...data, created_by: context.userId });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const verifyPlaybook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), verified: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    if ((await role(context)) !== "owner") throw new Error("Only the owner can verify playbooks.");
    const { error } = await context.supabase.from("playbooks").update({ verified: data.verified, verified_by: data.verified ? context.userId : null }).eq("id", data.id);
    if (error) throw new Error(error.message);
    await audit(context, "automation.playbook", data);
    return { ok: true };
  });

/** Dry-run: shows where a change would be routed under the current policy, and logs the decision. */
export const evaluateChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    action: z.enum(["merge", "deploy_staging", "deploy_production"]),
    categories: z.array(z.string().max(30)).max(10),
    filesChanged: z.number().int().min(0).max(10000), linesChanged: z.number().int().min(0).max(1000000),
    testsPassed: z.boolean(), branchProtected: z.boolean(), rollbackPlan: z.boolean(),
    guardianVerdict: z.enum(["pass", "fail", "none"]),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await role(context);
    const { data: p } = await context.supabase.from("automation_policy").select("*").eq("id", 1).single();
    if (!p) throw new Error("Automation policy not found.");
    const decision = routeApproval(data, { tier: p.tier as 0 | 1 | 2, paused: p.paused, guardianVerified: p.guardian_verified, maxFiles: p.max_files, maxLines: p.max_lines });
    const dispatch = canDispatch({ paused: p.paused }, OMNI_VERIFIED);
    await audit(context, "automation.decision", { change: data, route: decision.route, reasons: decision.reasons, dispatch: dispatch.reason }, decision.route);
    return { decision, dispatch };
  });

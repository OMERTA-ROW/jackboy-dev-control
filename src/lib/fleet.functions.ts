import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { CAPABILITIES, guardianCheck } from "./guardian";

type Ctx = { supabase: any; userId: string };
async function role(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (!data) throw new Error("Forbidden: Jackboy access requires an accepted invitation.");
  return data as "owner" | "admin" | "member";
}
const audit = (ctx: Ctx, action: string, detail: Record<string, unknown>, outcome = "ok") =>
  ctx.supabase.rpc("write_audit", { _action: action, _detail: detail, _outcome: outcome });

/** Verified integrations only. All false until a real authenticated check exists → Guardian denies by default. */
const INTEGRATIONS = { sandbox: false, search: false, omni: false, repo: false };

export const getFleet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const r = await role(context);
    const [a, p, pol, log] = await Promise.all([
      context.supabase.from("agents").select("*").order("created_at"),
      context.supabase.from("agent_projects").select("id, name, enrolled").order("name"),
      context.supabase.from("automation_policy").select("paused, tier, max_files, max_lines").eq("id", 1).single(),
      context.supabase.from("audit_logs").select("*").or("action.like.agent.%,action.like.guardian.%,action.like.hub.%").order("at", { ascending: false }).limit(30),
    ]);
    return { role: r, agents: a.data ?? [], projects: p.data ?? [], policy: pol.data, activity: log.data ?? [], integrations: INTEGRATIONS };
  });

export const addAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ projectId: z.string().uuid(), name: z.string().trim().min(2).max(60), category: z.enum(["angeltech", "demontech"]), specialty: z.string().trim().max(200) }).parse(d))
  .handler(async ({ data, context }) => {
    const r = await role(context);
    if (r === "member") throw new Error("Owner or admin only.");
    if (data.category === "demontech" && r !== "owner") throw new Error("Only the owner can register DemonTech agents.");
    const { error } = await context.supabase.from("agents").insert({ project_id: data.projectId, name: data.name, category: data.category, specialty: data.specialty, created_by: context.userId });
    if (error) throw new Error(error.message);
    await audit(context, "agent.register", { name: data.name, category: data.category, project: data.projectId });
    return { ok: true };
  });

export const updateAgent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), autonomy: z.enum(["observe", "propose", "experiment"]).optional(), paused: z.boolean().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const r = await role(context);
    if (r === "member") throw new Error("Owner or admin only.");
    // Raising autonomy is owner-only; anyone with manage rights may pause.
    if (data.autonomy && data.autonomy !== "observe" && r !== "owner") throw new Error("Only the owner can raise agent autonomy.");
    if (data.paused === false && r !== "owner") throw new Error("Only the owner can unpause an agent.");
    const patch: { autonomy?: string; paused?: boolean } = {};
    if (data.autonomy) patch.autonomy = data.autonomy;
    if (data.paused !== undefined) patch.paused = data.paused;
    const { error } = await context.supabase.from("agents").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    await audit(context, "agent.update", { id: data.id, ...patch });
    return { ok: true };
  });

export const emergencyPause = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ paused: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: p } = await context.supabase.from("automation_policy").select("*").eq("id", 1).single();
    if (!p) throw new Error("Policy missing.");
    const { error } = await context.supabase.rpc("set_automation_policy", { _tier: p.tier, _paused: data.paused, _max_files: p.max_files, _max_lines: p.max_lines });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Dry-run Guardian decision for an agent + action; logged. */
export const simulateGuardian = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ agentId: z.string().uuid(), action: z.enum(CAPABILITIES.map((c) => c.id) as [string, ...string[]]), targetProjectId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await role(context);
    const [{ data: a }, { data: p }] = await Promise.all([
      context.supabase.from("agents").select("*").eq("id", data.agentId).single(),
      context.supabase.from("automation_policy").select("paused").eq("id", 1).single(),
    ]);
    if (!a) throw new Error("Agent not found.");
    const v = guardianCheck({
      agent: { category: a.category, autonomy: a.autonomy, paused: a.paused, installedVerified: a.installed_verified, projectId: a.project_id },
      action: data.action as never, targetProjectId: data.targetProjectId, globalPaused: Boolean(p?.paused), integrations: INTEGRATIONS,
    });
    await audit(context, "guardian.check", { agent: a.name, action: data.action, reason: v.reason }, v.allow ? "allow" : "deny");
    return v;
  });

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { canTransition, STATUSES, type ProposalStatus } from "./update-writer";

type Ctx = { supabase: any; userId: string };
async function owner(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Owner only.");
}
const audit = (ctx: Ctx, action: string, detail: Record<string, unknown>, outcome = "ok") =>
  ctx.supabase.rpc("write_audit", { _action: action, _detail: detail, _outcome: outcome });

const projectInput = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  lovable_url: z.string().trim().max(500).refine((v) => !v || /^https:\/\//.test(v), "Link must start with https://"),
  description: z.string().trim().max(2000),
  goals: z.string().trim().max(4000),
  notes: z.string().trim().max(8000),
  active: z.boolean(),
});

export const getProjects = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  await owner(context);
  const { data, error } = await context.supabase.from("owner_projects").select("*").order("name");
  if (error) throw new Error(error.message);
  return data as Array<{ id: string; name: string; lovable_url: string | null; description: string; goals: string; notes: string; active: boolean; last_proposal_at: string | null }>;
});

export const saveProject = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => projectInput.parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const row = { name: data.name, lovable_url: data.lovable_url || null, description: data.description, goals: data.goals, notes: data.notes, active: data.active, updated_at: new Date().toISOString() };
    const res = data.id
      ? await context.supabase.from("owner_projects").update(row).eq("id", data.id)
      : await context.supabase.from("owner_projects").insert({ ...row, created_by: context.userId });
    if (res.error) throw new Error(res.error.message);
    await audit(context, data.id ? "projects.update" : "projects.create", { name: data.name });
    return { ok: true };
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

export const getQueue = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  await owner(context);
  const [p, s, l] = await Promise.all([
    context.supabase.from("update_proposals").select("*, owner_projects(name, lovable_url)").order("created_at", { ascending: false }).limit(200),
    context.supabase.from("update_writer_settings").select("frequency_hours, last_run_at, paused_reason, lock_until").eq("id", 1).single(),
    context.supabase.from("audit_logs").select("*").or("action.like.updates.%,action.like.projects.%").order("at", { ascending: false }).limit(30),
  ]);
  return {
    proposals: (p.data ?? []) as Array<{ id: string; project_id: string; status: ProposalStatus; title: string; what_to_change: string; why: string; build_prompt: string; model: string | null; trigger: string; edited: boolean; created_at: string; decided_at: string | null; owner_projects: { name: string; lovable_url: string | null } | null }>,
    settings: s.data as { frequency_hours: number; last_run_at: string | null; paused_reason: string | null; lock_until: string | null } | null,
    log: (l.data ?? []) as Array<{ id: string; at: string; action: string; outcome: string; detail: Record<string, unknown> }>,
  };
});

export const editProposal = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), title: z.string().trim().min(1).max(200), what_to_change: z.string().trim().min(1).max(4000), why: z.string().trim().min(1).max(3000), build_prompt: z.string().trim().min(1).max(12000) }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { id, ...rest } = data;
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
    if (!canTransition(cur.status, data.status)) throw new Error(`Can't move from ${cur.status} to ${data.status}.`);
    const { error } = await context.supabase.from("update_proposals").update({ status: data.status, decided_by: context.userId, decided_at: new Date().toISOString() }).eq("id", data.id);
    if (error) throw new Error(error.message);
    await audit(context, `updates.${data.status}`, { id: data.id, title: cur.title, from: cur.status });
    return { ok: true };
  });

export const setFrequency = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ hours: z.union([z.literal(0), z.literal(6), z.literal(12), z.literal(24), z.literal(72), z.literal(168)]), clearPause: z.boolean().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const patch: Record<string, unknown> = { frequency_hours: data.hours, updated_at: new Date().toISOString() };
    if (data.clearPause) patch["paused_reason"] = null;
    const { error } = await context.supabase.from("update_writer_settings").update(patch).eq("id", 1);
    if (error) throw new Error(error.message);
    await audit(context, "updates.schedule", { hours: data.hours, resumed: Boolean(data.clearPause) });
    return { ok: true };
  });

export const runNow = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ projectId: z.string().uuid().optional() }).parse(d ?? {}))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { runUpdateWriter } = await import("./update-writer.server");
    return runUpdateWriter({ trigger: "manual", actor: context.userId, ...(data.projectId ? { projectId: data.projectId } : {}) });
  });

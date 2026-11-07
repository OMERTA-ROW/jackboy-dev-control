import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function owner(ctx: { supabase: { rpc: (f: "my_role") => PromiseLike<{ data: unknown }> }; userId: string }) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Only the owner can use Task Mode.");
  return ctx.userId;
}
const id = z.string().uuid();
const view = (r: { task: Record<string, unknown>; steps: Record<string, unknown>[] }) => ({ task: r.task as never, steps: r.steps as never });

/** Owner reads (RLS as the user). */
export const listTasks = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await owner(context as never);
    const { data, error } = await context.supabase.from("tasks").select("id, goal, status, stop_reason, created_at, updated_at, failures").order("created_at", { ascending: false }).limit(30);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const getTask = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ taskId: id }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context as never);
    const [t, s, e] = await Promise.all([
      context.supabase.from("tasks").select("*").eq("id", data.taskId).maybeSingle(),
      context.supabase.from("task_steps").select("id, position, tool, step_type, args, fingerprint, project_id, why, status, approved_at, error, result, started_at, finished_at").eq("task_id", data.taskId).order("position"),
      context.supabase.from("task_events").select("id, step_id, kind, message, created_at").eq("task_id", data.taskId).order("created_at", { ascending: false }).limit(200),
    ]);
    if (!t.data) throw new Error("Task not found.");
    return { task: t.data, steps: (s.data ?? []).map((x) => ({ ...x, args: JSON.stringify(x.args), result: x.result == null ? null : JSON.stringify(x.result).slice(0, 2000) })), events: (e.data ?? []).reverse() };
  });

export const getSkipRules = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await owner(context as never);
    const [r, p] = await Promise.all([
      context.supabase.from("task_skip_rules").select("step_type, project_ids, updated_at"),
      context.supabase.from("owner_projects").select("id, name").eq("active", true).order("name"),
    ]);
    return { rules: r.data ?? [], projects: p.data ?? [] };
  });

/** AI drafts the steps; nothing runs until Start. */
export const planTaskFn = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ goal: z.string().trim().min(3).max(2000) }).parse(d))
  .handler(async ({ data, context }) => {
    const uid = await owner(context as never);
    return (await import("./task-mode.server")).planTask(uid, data.goal);
  });

export const startTaskFn = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ taskId: id }).parse(d))
  .handler(async ({ data, context }) => view(await (await import("./task-mode.server")).startTask(await owner(context as never), data.taskId)));

/** Moves a running task forward (the page calls this while open; the hourly job does it when closed). */
export const advanceTaskFn = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ taskId: id }).parse(d))
  .handler(async ({ data, context }) => {
    const uid = await owner(context as never);
    const s = await import("./task-mode.server");
    const { data: t } = await context.supabase.from("tasks").select("owner_id").eq("id", data.taskId).maybeSingle();
    if (t?.owner_id !== uid) throw new Error("Not your task.");
    return view(await s.runTask(data.taskId));
  });

export const approveTaskStepFn = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ stepId: id, grantId: id }).parse(d))
  .handler(async ({ data, context }) => view(await (await import("./task-mode.server")).approveStep(await owner(context as never), data.stepId, data.grantId)));

export const stopTaskFn = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ taskId: id }).parse(d))
  .handler(async ({ data, context }) => view(await (await import("./task-mode.server")).stopTask(await owner(context as never), data.taskId)));

export const retryTaskFn = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ taskId: id }).parse(d))
  .handler(async ({ data, context }) => view(await (await import("./task-mode.server")).retryTask(await owner(context as never), data.taskId)));

export const setSkipRuleFn = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ stepType: z.string(), projectIds: z.array(id).max(50), grantId: id }).parse(d))
  .handler(async ({ data, context }) => (await import("./task-mode.server")).setSkipRule(await owner(context as never), data.stepType, data.projectIds, data.grantId));

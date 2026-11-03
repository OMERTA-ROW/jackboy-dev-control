import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Ctx = { supabase: any; userId: string };
async function owner(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Owner only.");
}
const audit = (ctx: Ctx, action: string, detail: Record<string, unknown>) => ctx.supabase.rpc("write_audit", { _action: action, _detail: detail, _outcome: "ok" });
const idOnly = (d: unknown) => z.object({ id: z.string().uuid() }).parse(d);

export type ScanRow = { id: string; project_id: string; status: string; trigger: string; pages_checked: number; links_checked: number; avg_ms: number | null; findings: { severity: string; kind: string; url: string; message: string }[]; error: string | null; fix_proposal_id: string | null; created_at: string };

export const getAutopilot = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  await owner(context);
  const [s, p, sc, a] = await Promise.all([
    context.supabase.from("update_writer_settings").select("autopilot_enabled, paused_reason").eq("id", 1).single(),
    context.supabase.from("owner_projects").select("id, name, site_url, github_repo, autopilot, connect_state, connect_pr_url, connect_error").order("name"),
    context.supabase.from("site_scans").select("*").order("created_at", { ascending: false }).limit(30),
    context.supabase.from("audit_logs").select("id, at, action, outcome, detail").or("action.like.autopilot.%,action.like.chat.%,action.like.updates.%").order("at", { ascending: false }).limit(40),
  ]);
  return {
    master: Boolean(s.data?.autopilot_enabled), paused: (s.data?.paused_reason ?? null) as string | null,
    projects: (p.data ?? []) as Array<{ id: string; name: string; site_url: string | null; github_repo: string | null; autopilot: boolean; connect_state: string; connect_pr_url: string | null; connect_error: string | null }>,
    scans: (sc.data ?? []) as unknown as ScanRow[],
    activity: (a.data ?? []) as Array<{ id: string; at: string; action: string; outcome: string; detail: { name?: string; title?: string; error?: string; command?: string; project?: string; on?: boolean } }>,
    githubConfigured: (await (await import("./github-app.server")).githubAvailable()).ok,
  };
});

export const setMasterAutopilot = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ on: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { error } = await context.supabase.from("update_writer_settings").update({ autopilot_enabled: data.on }).eq("id", 1);
    if (error) throw new Error(error.message);
    await audit(context, "autopilot.master", { on: data.on });
    return { ok: true };
  });

export const setProjectAutopilot = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), on: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { error } = await context.supabase.from("owner_projects").update({ autopilot: data.on }).eq("id", data.id);
    if (error) throw new Error(error.message);
    await audit(context, "autopilot.project", { project: data.id, on: data.on });
    return { ok: true };
  });

export const connectAndScan = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator(idOnly)
  .handler(async ({ data, context }) => { await owner(context); const s = await import("./autopilot.server"); return { steps: await s.onProjectAdded(data.id, context.userId) }; });

export const scanNow = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator(idOnly)
  .handler(async ({ data, context }) => { await owner(context); const s = await import("./autopilot.server"); const r = await s.scanSite(data.id, "manual", context.userId); return { findings: r.findings.length, pages: r.pages, scanId: r.scanId }; });

export const fixScan = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).inputValidator(idOnly)
  .handler(async ({ data, context }) => {
    await owner(context);
    const { data: scan } = await context.supabase.from("site_scans").select("project_id, findings").eq("id", data.id).single();
    if (!scan) throw new Error("Scan not found.");
    const f = (scan.findings as ScanRow["findings"]).filter((x) => x.severity !== "low");
    if (!f.length) throw new Error("No medium or high findings to fix.");
    const s = await import("./autopilot.server");
    return s.writeFix(scan.project_id, f.map((x) => `- [${x.severity}] ${x.kind} ${x.url}: ${x.message}`).join("\n"), "scan", context.userId, data.id);
  });

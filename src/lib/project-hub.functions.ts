import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Ctx = { supabase: any; userId: string };
async function owner(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Owner only.");
}

export type HubRow = { id: string; name: string; site_url: string | null; lovable_url: string | null; github_repo: string | null; github_branch: string; autopilot: boolean; connect_state: string; connect_error: string | null; description: string; goals: string; notes: string; frequency_hours: number; active: boolean; connect_pr_url: string | null };
export type HubScanRow = { id: string; project_id: string; status: string; trigger: string; pages_checked: number; links_checked: number; avg_ms: number | null; findings: { severity: string; kind: string; url: string; message: string }[]; error: string | null; fix_proposal_id: string | null; created_at: string };
export type HubProposal = { id: string; project_id: string; title: string; status: string; source: string; pr_url: string | null; checks_state: string | null; created_at: string };

/** Owner-only overview: connected projects, latest scans, waiting approvals and the stored Lovable inventory snapshot. */
export const getProjectHub = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  await owner(context);
  const [p, s, q, inv] = await Promise.all([
    context.supabase.from("owner_projects").select("*").order("name"),
    context.supabase.from("site_scans").select("id,project_id,status,trigger,pages_checked,links_checked,avg_ms,findings,error,fix_proposal_id,created_at").order("created_at", { ascending: false }).limit(200),
    context.supabase.from("update_proposals").select("id,project_id,title,status,source,pr_url,checks_state,created_at").in("status", ["draft", "pr_open", "approved"]).order("created_at", { ascending: false }).limit(200),
    context.supabase.from("agent_projects").select("id,name,lovable_project_ref").not("lovable_project_ref", "is", null).order("name"),
  ]);
  for (const r of [p, s, q, inv]) if (r.error) throw new Error(r.error.message);
  return {
    projects: (p.data ?? []) as HubRow[],
    scans: (s.data ?? []) as HubScanRow[],
    waiting: (q.data ?? []) as HubProposal[],
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
    return { project: (p.data ?? null) as HubRow | null, scans: (s.data ?? []) as HubScanRow[], proposals: (q.data ?? []) as HubProposal[], githubConfigured: Boolean(process.env["GITHUB_TOKEN"]) };
  });

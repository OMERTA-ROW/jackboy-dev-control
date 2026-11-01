// Owner-only Connect/Reconnect for one project: link a repo the account can write, approve with passkey,
// verify with real GitHub calls, then (only if verified) enable background work and run the first scan.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { connectionState, suggestRepo } from "./project-connect";

async function owner(ctx: { supabase: any; userId: string }) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Owner only.");
  return `owner:${ctx.userId}`;
}

export const getProjectConnection = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ projectId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const db = context.supabase;
    const [p, g, t, pk, log] = await Promise.all([
      db.from("owner_projects").select("id,name,github_repo,github_branch,dev_enabled,site_url,site_status").eq("id", data.projectId).single(),
      db.from("capability_grants").select("id,capability,status,last_error,last_verified_at,account").eq("project_id", data.projectId),
      db.from("foundry_tasks").select("id,title,state,branch,pr_url,blocked_reason,test_evidence,updated_at").eq("project_id", data.projectId).order("updated_at", { ascending: false }).limit(8),
      db.from("foundry_packages").select("id,version,package_sha256,created_at").eq("project_id", data.projectId).order("created_at", { ascending: false }).limit(5),
      db.from("site_log").select("id,at,action,status,summary").eq("project_id", data.projectId).order("at", { ascending: false }).limit(10),
    ]);
    if (p.error) throw new Error(p.error.message);
    let repos: { repo: string; usable: boolean; visibility: string; org: string | null }[] = [];
    let reposError: string | null = null;
    try { repos = await (await import("./repo-workspace.server")).listAccessibleRepos(); } catch (e) { reposError = (e as Error).message; }
    const grants = g.data ?? [];
    const repoGrant = grants.find((x: { capability: string }) => x.capability === "github_repo") ?? null;
    return {
      project: p.data, grants, tasks: t.data ?? [], packages: pk.data ?? [], log: log.data ?? [],
      repos: repos.filter((r) => r.usable).map((r) => ({ repo: r.repo, visibility: r.visibility, org: r.org })),
      reposError, suggestion: p.data.github_repo ? null : suggestRepo(p.data.name, repos)?.repo ?? null,
      connection: connectionState(p.data.github_repo, repoGrant), connectionId: repoGrant?.id ?? null,
    };
  });

export const connectProject = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ projectId: z.string().uuid(), repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/), grantId: z.string().uuid().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const actor = await owner(context);
    // Passkey: linking/approving repo write access is a new permission.
    await (await import("./passkey.server")).consumeGrant(data.grantId, context.userId, "approve_integration", `github_repo:${data.projectId}`);
    const ws = await import("./repo-workspace.server");
    const usable = (await ws.listAccessibleRepos()).find((r) => r.repo.toLowerCase() === data.repo.toLowerCase());
    if (!usable?.usable) throw new Error(`The connected GitHub account cannot write ${data.repo}. Grant it access on GitHub first.`);
    const { error } = await context.supabase.from("owner_projects").update({ github_repo: usable.repo, updated_at: new Date().toISOString() }).eq("id", data.projectId);
    if (error) throw new Error(error.message);
    const ac = await import("./autoconnect.server");
    await ac.approveCapability("github_repo", data.projectId, actor, context.userId);
    const v = await ac.verifyCapability("github_repo", data.projectId, actor); // real read + branch create/delete + PR list
    const { logSite } = await import("./site-log.server");
    if (v.status !== "connected") {
      await logSite({ actor, action: "project_connect", category: "config", status: "blocked", project_id: data.projectId, repo: usable.repo, summary: `Connect ${usable.repo} blocked: ${v.detail}` });
      return { connected: false, detail: v.detail, scan: null };
    }
    await context.supabase.from("owner_projects").update({ dev_enabled: true }).eq("id", data.projectId);
    let scan: unknown = null;
    try { scan = await (await import("./foundry.server")).inspectProject(data.projectId, actor, "manual", 1); } catch (e) { scan = { error: (e as Error).message }; }
    await logSite({ actor, action: "project_connect", category: "config", status: "ok", project_id: data.projectId, repo: usable.repo, summary: `Connected ${usable.repo} (${v.detail}). Background work enabled; first scan: ${JSON.stringify(scan).slice(0, 200)}` });
    return { connected: true, detail: v.detail, scan };
  });

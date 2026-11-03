import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { projectRepoMatch, normalizeRepo } from "./repository-resync";
import { isSafeSiteUrl, repoNameToDisplay } from "./project-resync";

type Ctx = { supabase: any; userId: string };
async function owner(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Owner only.");
}

export type ProjectResyncResult = { projectId: string; name: string; repo: string | null; repoState: "ok" | "gone" | "unlinked" | "unchecked"; credential: "GitHub App installation" | "GITHUB_TOKEN" | "none"; siteUrl: string | null; changes: string[]; notes: string[]; proposedRepo: string | null };

/** Re-identifies ONE project from its linked repo. Changes only the display name and an empty site address; repo-link changes still go through the approved review. */
export async function resyncOne(projectId: string, actor: string): Promise<ProjectResyncResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const app = await import("./github-app.server");
  const { data: p, error } = await supabaseAdmin.from("owner_projects").select("id,name,github_repo,site_url,lovable_url").eq("id", projectId).single();
  if (error || !p) throw new Error(error?.message ?? "Project not found");
  const out: ProjectResyncResult = { projectId, name: p.name, repo: p.github_repo, repoState: "unchecked", credential: "none", siteUrl: p.site_url, changes: [], notes: [], proposedRepo: null };
  const update: Record<string, unknown> = {};
  if (!p.github_repo) {
    out.repoState = "unlinked";
    try {
      const repos = await app.appRepositoryCandidates();
      out.proposedRepo = projectRepoMatch(p.name, p.lovable_url, repos);
    } catch (e) { out.notes.push(`Could not read GitHub App repos: ${(e as Error).message}`); }
    out.notes.push(out.proposedRepo ? `Possible repo: ${out.proposedRepo}. Approve it in Settings → Repository review.` : "No repo linked.");
  } else {
    const repo = normalizeRepo(p.github_repo);
    const cred = await app.githubTokenFor(repo).catch(() => null);
    out.credential = cred?.via === "app" ? "GitHub App installation" : cred?.via === "token" ? "GITHUB_TOKEN" : "none";
    if (!cred) out.notes.push("No credential covers this repo: install the GitHub App on its owner or link a repo the App can reach.");
    else {
      const r = await fetch(`https://api.github.com/repos/${repo}`, { headers: { Authorization: `Bearer ${cred.token}`, Accept: "application/vnd.github+json", "User-Agent": "Jackboy" }, redirect: "follow", signal: AbortSignal.timeout(10_000) });
      if (r.status === 404) { out.repoState = "gone"; out.notes.push("GitHub reports this repo as not found. You can remove the project from the list; its history is kept."); }
      else if (!r.ok) out.notes.push(`GitHub ${r.status} while checking the repo; nothing changed.`);
      else {
        out.repoState = "ok";
        const body = await r.json() as { full_name: string; homepage: string | null; name: string };
        if (body.full_name.toLowerCase() !== repo.toLowerCase()) out.notes.push(`Repo was renamed to ${body.full_name}. Approve the new link in Settings → Repository review.`);
        const display = repoNameToDisplay(body.name);
        if (display && !p.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(display.toLowerCase().replace(/[^a-z0-9]/g, "")) && body.full_name.toLowerCase() === repo.toLowerCase()) { update["name"] = display; out.changes.push(`Name: ${p.name} → ${display}`); out.name = display; }
        if (!p.site_url && body.homepage && isSafeSiteUrl(body.homepage)) { update["site_url"] = body.homepage; update["site_status"] = "checking"; out.changes.push(`Site address: ${body.homepage}`); out.siteUrl = body.homepage; }
      }
    }
  }
  if (!out.siteUrl) out.notes.push("No site address found on the repo — add it with “Add site address to scan”.");
  if (Object.keys(update).length) {
    const u = await supabaseAdmin.from("owner_projects").update({ ...update, updated_at: new Date().toISOString() }).eq("id", projectId);
    if (u.error) throw new Error(u.error.message);
    if (update["name"]) await supabaseAdmin.from("agent_projects").update({ name: String(update["name"]) }).eq("name", p.name);
  }
  await (await import("./site-log.server")).logSite({ actor, action: "project.resync", summary: `${out.name}: ${out.changes.length ? out.changes.join("; ") : "no changes"} · credential ${out.credential}`, project_id: projectId, repo: out.repo, status: out.repoState === "gone" ? "warning" : "info", detail: { ...out } });
  return out;
}

export const resyncProject = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => { await owner(context); return resyncOne(data.id, context.userId); });

/** Removes a project from the active list only after GitHub confirms its repo is gone. Records stay; restore anytime. */
export const archiveGoneProject = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const check = await resyncOne(data.id, context.userId);
    if (check.repoState !== "gone") throw new Error("Not removed: GitHub did not confirm this project's repo is gone.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const u = await supabaseAdmin.from("owner_projects").update({ active: false, dev_enabled: false, autopilot: false, updated_at: new Date().toISOString() }).eq("id", data.id);
    if (u.error) throw new Error(u.error.message);
    await (await import("./site-log.server")).logSite({ actor: context.userId, action: "project.archived", summary: `${check.name} removed from Projects (repo ${check.repo} not found). History kept.`, project_id: data.id, repo: check.repo, status: "warning" });
    return { ok: true };
  });

export const restoreProject = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { error } = await context.supabase.from("owner_projects").update({ active: true }).eq("id", data.id);
    if (error) throw new Error(error.message);
    await (await import("./site-log.server")).logSite({ actor: context.userId, action: "project.restored", summary: "Project restored to the Projects list.", project_id: data.id });
    return { ok: true };
  });

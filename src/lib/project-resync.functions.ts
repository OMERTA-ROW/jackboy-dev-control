import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { projectRepoMatch, normalizeRepo } from "./repository-resync";
import { deadReason, isSafeSiteUrl, pickDeploymentUrl, publishedLovableUrl, repoNameToDisplay, type DeployStatus } from "./project-resync";

type Ctx = { supabase: any; userId: string };
async function owner(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Owner only.");
}

export type ProjectResyncResult = { projectId: string; name: string; repo: string | null; repoState: "ok" | "gone" | "unlinked" | "unchecked"; credential: "GitHub App installation" | "GITHUB_TOKEN" | "none"; siteUrl: string | null; changes: string[]; notes: string[]; proposedRepo: string | null; dead: string | null };

/** Re-identifies ONE project from its linked repo. Changes only the display name and an empty site address; repo-link changes still go through the approved review. */
export async function resyncOne(projectId: string, actor: string): Promise<ProjectResyncResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const app = await import("./github-app.server");
  const { data: p, error } = await supabaseAdmin.from("owner_projects").select("id,name,github_repo,site_url,lovable_url").eq("id", projectId).single();
  if (error || !p) throw new Error(error?.message ?? "Project not found");
  const out: ProjectResyncResult = { projectId, name: p.name, repo: p.github_repo, repoState: "unchecked", credential: "none", siteUrl: p.site_url, changes: [], notes: [], proposedRepo: null, dead: null };
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
    // Existence-only read may use GITHUB_TOKEN even where it isn't allowed for work; nothing is written with it.
    const readToken = cred?.token ?? process.env["GITHUB_TOKEN"]?.trim();
    if (!cred) out.notes.push("No work credential covers this repo: install the GitHub App on its owner or link a repo the App can reach.");
    if (readToken) {
      const r = await fetch(`https://api.github.com/repos/${repo}`, { headers: { Authorization: `Bearer ${readToken}`, Accept: "application/vnd.github+json", "User-Agent": "Jackboy" }, redirect: "follow", signal: AbortSignal.timeout(10_000) });
      if (r.status === 404) { out.repoState = "gone"; out.notes.push("GitHub reports this repo as not found. You can remove the project from the list; its history is kept."); }
      else if (!r.ok) out.notes.push(`GitHub ${r.status} while checking the repo; nothing changed.`);
      else {
        out.repoState = "ok";
        const body = await r.json() as { full_name: string; homepage: string | null; name: string; archived?: boolean; pushed_at?: string | null };
        out.dead = deadReason({ state: "ok", archived: body.archived, pushedAt: body.pushed_at ?? null });
        if (body.full_name.toLowerCase() !== repo.toLowerCase()) out.notes.push(`Repo was renamed to ${body.full_name}. Approve the new link in Settings → Repository review.`);
        const display = repoNameToDisplay(body.name);
        if (display && !p.name.toLowerCase().replace(/[^a-z0-9]/g, "").includes(display.toLowerCase().replace(/[^a-z0-9]/g, "")) && body.full_name.toLowerCase() === repo.toLowerCase()) { update["name"] = display; out.changes.push(`Name: ${p.name} → ${display}`); out.name = display; }
        if (!p.site_url && body.homepage && isSafeSiteUrl(body.homepage)) { update["site_url"] = body.homepage; update["site_status"] = "checking"; out.changes.push(`Site address (repo homepage): ${body.homepage}`); out.siteUrl = body.homepage; }
        if (!out.siteUrl) {
          // GitHub deployments: Vercel, Netlify and Lovable report the live address here.
          try {
            const h = { Authorization: `Bearer ${readToken}`, Accept: "application/vnd.github+json", "User-Agent": "Jackboy" };
            const deps = await fetch(`https://api.github.com/repos/${repo}/deployments?per_page=10`, { headers: h, signal: AbortSignal.timeout(10_000) });
            const list = deps.ok ? await deps.json() as { id: number; environment: string }[] : [];
            const statuses: DeployStatus[] = [];
            for (const d of list.slice(0, 5)) {
              const s = await fetch(`https://api.github.com/repos/${repo}/deployments/${d.id}/statuses?per_page=1`, { headers: h, signal: AbortSignal.timeout(10_000) });
              const st = s.ok ? (await s.json() as { state: string; environment_url?: string | null }[])[0] : undefined;
              if (st) statuses.push({ environment: d.environment, state: st.state, environment_url: st.environment_url ?? null });
            }
            const url = pickDeploymentUrl(statuses);
            if (url) { update["site_url"] = url; update["site_status"] = "checking"; out.changes.push(`Site address (deployment): ${url}`); out.siteUrl = url; }
          } catch (e) { out.notes.push(`Could not read deployments: ${(e as Error).message}`); }
        }
      }
    }
  }
  if (out.repoState === "gone") out.dead = deadReason({ state: "gone" });
  const published = publishedLovableUrl(p.lovable_url);
  if (!out.siteUrl && published) { update["site_url"] = published; update["site_status"] = "checking"; out.changes.push(`Site address (Lovable published): ${published}`); out.siteUrl = published; }
  if (!out.siteUrl) out.notes.push("No site address found on the repo — add it with “Add site address to scan”.");
  if (Object.keys(update).length) {
    const u = await supabaseAdmin.from("owner_projects").update({ ...update, updated_at: new Date().toISOString() }).eq("id", projectId);
    if (u.error) throw new Error(u.error.message);
    if (update["name"]) await supabaseAdmin.from("agent_projects").update({ name: String(update["name"]) }).eq("name", p.name);
  }
  await (await import("./site-log.server")).logSite({ actor, action: "project.resync", summary: `${out.name}: ${out.changes.length ? out.changes.join("; ") : "no changes"} · credential ${out.credential}`, project_id: projectId, repo: out.repo, status: out.repoState === "gone" ? "blocked" : "info", detail: { ...out } });
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
    await (await import("./site-log.server")).logSite({ actor: context.userId, action: "project.archived", summary: `${check.name} removed from Projects (repo ${check.repo} not found). History kept.`, project_id: data.id, repo: check.repo, status: "info" });
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

/** Runs detection for every active project missing a site address; returns what was filled and what still needs the owner. */
export const detectSiteAddresses = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await owner(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin.from("owner_projects").select("id,name").eq("active", true).is("site_url", null).order("name");
    const filled: { name: string; url: string }[] = []; const missing: { id: string; name: string }[] = [];
    for (const p of data ?? []) {
      try { const r = await resyncOne(p.id, context.userId); if (r.siteUrl) filled.push({ name: r.name, url: r.siteUrl }); else missing.push({ id: p.id, name: r.name }); }
      catch { missing.push({ id: p.id, name: p.name }); }
    }
    return { filled, missing };
  });

/** Review list for "Archive dead projects": repo gone, archived on GitHub, or no push for a year. Nothing is archived here. */
export const findDeadProjects = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await owner(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin.from("owner_projects").select("id").eq("active", true).not("github_repo", "is", null);
    const out: { id: string; name: string; repo: string | null; reason: string }[] = [];
    for (const p of data ?? []) {
      try { const r = await resyncOne(p.id, context.userId); if (r.dead) out.push({ id: p.id, name: r.name, repo: r.repo, reason: r.dead }); } catch { /* unverifiable projects are never proposed */ }
    }
    return out;
  });

/** Archives only the projects the owner confirmed, re-verifying each is still dead. History is kept; restore anytime. */
export const archiveDeadProjects = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ ids: z.array(z.string().uuid()).min(1).max(50) }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const results: { id: string; name: string; archived: boolean; reason: string }[] = [];
    for (const id of data.ids) {
      const r = await resyncOne(id, context.userId).catch((e) => ({ name: id, dead: null, repo: null, err: (e as Error).message }) as never as ProjectResyncResult);
      if (!r.dead) { results.push({ id, name: r.name, archived: false, reason: "Not archived: no longer confirmed dead." }); continue; }
      const u = await supabaseAdmin.from("owner_projects").update({ active: false, dev_enabled: false, autopilot: false, updated_at: new Date().toISOString() }).eq("id", id);
      if (u.error) { results.push({ id, name: r.name, archived: false, reason: u.error.message }); continue; }
      await (await import("./site-log.server")).logSite({ actor: context.userId, action: "project.archived", summary: `${r.name} archived by owner (${r.dead}). History kept.`, project_id: id, repo: r.repo, status: "info" });
      results.push({ id, name: r.name, archived: true, reason: r.dead });
    }
    return results;
  });

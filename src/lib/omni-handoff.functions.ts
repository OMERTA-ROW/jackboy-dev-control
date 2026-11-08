// Owner server functions for OMNI build/test handoffs: read-only status, per-project authorization
// (fresh passkey) and revocation. The database re-checks every rule; nothing here sends work to OMNI.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import {
  evaluateHandoff,
  HANDOFF_KINDS,
  MAX_PROJECT_AUTH_DAYS,
  validateAuthorizationRequest,
  registryRepoSuggestion,
  repoFromUrl,
  jobCopyRefusal,
  type HandoffFacts,
} from "./omni-handoff-auth";

type Ctx = {
  userId: string;
  supabase: {
    rpc: (f: "my_role") => PromiseLike<{ data: unknown }>;
    auth: { getUser: () => Promise<{ error: unknown; data: { user: { id: string; email_confirmed_at?: string | null } | null } }> };
  };
};

async function requireConfirmedOwner(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Only the owner can manage OMNI handoffs.");
  const identity = await ctx.supabase.auth.getUser();
  if (identity.error || identity.data.user?.id !== ctx.userId || !identity.data.user.email_confirmed_at)
    throw new Error("A confirmed owner session is required.");
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { untyped } = await import("./untyped-db");
  return untyped(supabaseAdmin);
}

type ProjectRow = { id: string; name: string; enrolled: boolean; repo_url: string | null; created_by: string | null };
type AuthRow = {
  id: string; project_id: string; owner_id: string; kinds: string[]; repo: string;
  expires_at: string; revoked_at: string | null; revoked_reason: string | null; created_at: string;
};
type JobRow = {
  id: string; project_id: string | null; kind: string; status: string; sent_at: string | null;
  code_request_id: string | null; repo: string | null; instructions: string; created_at: string;
};
type GrantRow = { id: string; job_id: string; expires_at: string; revoked_at: string | null; created_at: string };

/** Read-only: live link state, project authorizations and every queued build/test job with its blockers. */
export const getOmniHandoffs = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireConfirmedOwner(context as unknown as Ctx);
    const db = await admin();
    const { isOmniVerified } = await import("./omni-link.server");
    const live = await isOmniVerified();
    const [conn, policy, projects, auths, jobs, grants, ownerProjects] = await Promise.all([
      db.from("omni_connection").select("verified, verified_at, last_error").eq("id", true).maybeSingle(),
      db.from("automation_policy").select("paused").eq("id", 1).maybeSingle(),
      db.from("agent_projects").select("id,name,enrolled,repo_url,created_by").order("name"),
      db.from("omni_project_authorizations").select("*").order("created_at", { ascending: false }).limit(100),
      db
        .from("omni_jobs")
        .select("id,project_id,kind,status,sent_at,code_request_id,repo,instructions,created_at")
        .in("kind", ["code", "test"])
        .eq("status", "queued")
        .is("sent_at", null)
        .is("code_request_id", null)
        .order("created_at", { ascending: false })
        .limit(50),
      db
        .from("omni_dispatch_grants")
        .select("id,job_id,expires_at,revoked_at,created_at")
        .order("created_at", { ascending: false })
        .limit(200),
      db.from("owner_projects").select("name, github_repo"),
    ]);
    const ownerList = ((ownerProjects.data ?? []) as { name: string; github_repo: string | null }[]);
    if (projects.error || auths.error || jobs.error || grants.error)
      throw new Error("OMNI handoff records could not be loaded.");
    const now = Date.now();
    const killSwitchOn = (policy.data as { paused?: boolean } | null)?.paused !== false;
    const c = conn.data as { verified?: boolean; verified_at?: string | null; last_error?: string | null } | null;
    const link = { verified: live, verifiedAt: live ? (c?.verified_at ?? null) : null, configMatches: live };
    const projectRows = (projects.data ?? []) as ProjectRow[];
    const authRows = (auths.data ?? []) as AuthRow[];
    const currentAuth = (projectId: string) =>
      authRows.find((a) => a.project_id === projectId && !a.revoked_at) ?? null;
    const grantRows = (grants.data ?? []) as GrantRow[];

    const handoffs = ((jobs.data ?? []) as JobRow[]).map((j) => {
      const p = projectRows.find((x) => x.id === j.project_id) ?? null;
      const a = j.project_id ? currentAuth(j.project_id) : null;
      const g = grantRows.find((x) => x.job_id === j.id) ?? null;
      const liveGrant = g && !g.revoked_at && Date.parse(g.expires_at) > now ? g : null;
      const facts: HandoffFacts = {
        isOwner: true,
        actorId: context.userId,
        killSwitchOn,
        link,
        project: p ? { id: p.id, ownerId: p.created_by, enrolled: p.enrolled, repoUrl: p.repo_url } : null,
        job: {
          projectId: j.project_id, kind: j.kind, status: j.status, sentAt: j.sent_at,
          codeRequestId: j.code_request_id, repo: j.repo, instructions: j.instructions,
        },
        authorization: a
          ? { projectId: a.project_id, ownerId: a.owner_id, kinds: a.kinds, repo: a.repo, expiresAt: a.expires_at, revokedAt: a.revoked_at }
          : null,
        grant: liveGrant ? { expiresAt: liveGrant.expires_at, revokedAt: null } : null,
      };
      const verdict = evaluateHandoff(facts, liveGrant ? "use" : "issue", now);
      const projectRepo = repoFromUrl(p?.repo_url ?? null);
      const copyRefusal = jobCopyRefusal(
        { status: j.status, sentAt: j.sent_at, codeRequestId: j.code_request_id, repo: j.repo, kind: j.kind },
        projectRepo,
      );
      return {
        copyRepo: copyRefusal ? null : projectRepo,
        // Plain next step when the job lacks a repository: link the project, then queue a copy.
        repoFix: j.repo
          ? null
          : projectRepo
            ? `Press "Queue a copy for ${projectRepo}". The original job stays exactly as it is.`
            : p && registryRepoSuggestion(p.name, ownerList)
              ? `First link ${registryRepoSuggestion(p.name, ownerList)} to ${p.name} under Project access above, then queue a copy here.`
              : `${p?.name ?? "This project"} has no GitHub repository on the Projects page either. Link one there first.`,
        jobId: j.id,
        projectId: j.project_id,
        projectName: p?.name ?? "Unknown project",
        kind: j.kind,
        repo: j.repo,
        instructions: j.instructions.slice(0, 300),
        createdAt: j.created_at,
        grant: liveGrant ? { id: liveGrant.id, expiresAt: liveGrant.expires_at } : null,
        allowed: verdict.allowed,
        blockers: verdict.blockers,
      };
    });

    return {
      link: { live, lastError: c?.last_error ?? null, verifiedAt: c?.verified_at ?? null },
      killSwitchOn,
      projects: projectRows.map((p) => {
        const a = currentAuth(p.id);
        const current = a && Date.parse(a.expires_at) > now ? a : null;
        const repo = repoFromUrl(p.repo_url);
        const eligible = p.created_by === context.userId && p.enrolled && Boolean(repo);
        const suggestedRepo = !repo && p.created_by === context.userId ? registryRepoSuggestion(p.name, ownerList) : null;
        return {
          id: p.id,
          name: p.name,
          repo,
          suggestedRepo,
          eligible,
          ineligibleReason: eligible
            ? null
            : p.created_by !== context.userId
              ? "Belongs to someone else"
              : !p.enrolled
                ? "Not enrolled yet"
                : suggestedRepo
                  ? `No repository in OMNI's project list. The Projects page links ${suggestedRepo}.`
                  : "No GitHub repository linked here or on the Projects page",
          authorization: current
            ? { id: current.id, kinds: current.kinds, repo: current.repo, expiresAt: current.expires_at }
            : null,
        };
      }),
      recentRevocations: authRows
        .filter((a) => a.revoked_at)
        .slice(0, 10)
        .map((a) => ({
          projectId: a.project_id,
          revokedAt: a.revoked_at as string,
          reason: a.revoked_reason ?? "revoked",
        })),
      handoffs,
      maxDays: MAX_PROJECT_AUTH_DAYS,
    };
  });

/** Owner + fresh passkey (`omni_project_scope`, target `omni-project:<id>`) while the link is live. */
export const authorizeOmniProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z
      .object({
        projectId: z.string().uuid(),
        kinds: z.array(z.enum(HANDOFF_KINDS as [string, ...string[]])).min(1).max(2),
        days: z.number().int(),
        grantId: z.string().uuid(),
      })
      .strict()
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireConfirmedOwner(context as unknown as Ctx);
    const invalid = validateAuthorizationRequest({ kinds: data.kinds, days: data.days });
    if (invalid) throw new Error(invalid);
    const { isOmniVerified } = await import("./omni-link.server");
    if (!(await isOmniVerified()))
      throw new Error("OMNI's live link is not verified right now. Check the connection, then authorize.");
    const db = await admin();
    const result = await db.rpc("omni_project_authorization_action", {
      _op: "grant",
      _actor: context.userId,
      _project: data.projectId,
      _kinds: [...new Set(data.kinds)],
      _step: data.grantId,
      _days: data.days,
      _reason: null,
    });
    if (result.error || !result.data)
      throw new Error(`OMNI access could not be granted: ${result.error?.message?.slice(0, 160) ?? "no result"}.`);
    return z
      .object({ id: z.string().uuid(), projectId: z.string().uuid(), kinds: z.array(z.string()), repo: z.string(), expiresAt: z.string() })
      .parse(result.data);
  });

/** Revoking is always allowed for the owner (no passkey): it only removes access, and also
 * revokes every live job approval for that project in the same transaction. */
export const revokeOmniProject = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) =>
    z.object({ projectId: z.string().uuid(), reason: z.string().max(300).optional() }).strict().parse(input),
  )
  .handler(async ({ context, data }) => {
    await requireConfirmedOwner(context as unknown as Ctx);
    const db = await admin();
    const result = await db.rpc("omni_project_authorization_action", {
      _op: "revoke",
      _actor: context.userId,
      _project: data.projectId,
      _kinds: null,
      _step: null,
      _days: null,
      _reason: data.reason ?? null,
    });
    if (result.error || !result.data) throw new Error("OMNI access could not be revoked.");
    return z.object({ revoked: z.literal(true), revokedJobApprovals: z.number() }).parse(result.data);
  });

/** Owner only: fill an EMPTY repository on OMNI's project list with the one the owner already linked
 * on the Projects page (exactly one same-named project). Grants nothing: OMNI still needs the
 * passkey "Give OMNI access" step, which binds this repository. Never overwrites an existing link. */
export const linkOmniProjectRepo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ projectId: z.string().uuid() }).strict().parse(input))
  .handler(async ({ context, data }) => {
    await requireConfirmedOwner(context as unknown as Ctx);
    const db = await admin();
    const { data: p } = await db.from("agent_projects").select("id,name,repo_url,created_by").eq("id", data.projectId).maybeSingle();
    const row = p as { id: string; name: string; repo_url: string | null; created_by: string | null } | null;
    if (!row) throw new Error("Project not found.");
    if (row.created_by !== context.userId) throw new Error("This project belongs to someone else.");
    if (row.repo_url) throw new Error("This project already has a repository; it was not changed.");
    const { data: owners } = await db.from("owner_projects").select("name, github_repo");
    const repo = registryRepoSuggestion(row.name, (owners ?? []) as { name: string; github_repo: string | null }[]);
    if (!repo) throw new Error(`No single project named "${row.name}" with a GitHub repository was found on the Projects page.`);
    const { data: updated, error } = await db
      .from("agent_projects")
      .update({ repo_url: `https://github.com/${repo}` })
      .eq("id", row.id)
      .is("repo_url", null)
      .select("id");
    if (error || !updated || (updated as unknown[]).length !== 1) throw new Error("The repository could not be linked (nothing changed).");
    const { logSite } = await import("./site-log.server");
    await logSite({
      actor: context.userId, action: "omni.project.repo_linked", category: "config", status: "ok", repo,
      summary: `Linked ${repo} to ${row.name} in OMNI's project list (from the Projects page). OMNI access still needs a passkey.`,
    });
    return { repo, name: row.name };
  });

/** Owner only: queue a NEW unsent copy of a repository-less build/test job, carrying its project's
 * repository. The original job is never changed; nothing is sent (handoff rules still apply). */
export const queueOmniJobCopy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ jobId: z.string().uuid() }).strict().parse(input))
  .handler(async ({ context, data }) => {
    await requireConfirmedOwner(context as unknown as Ctx);
    const db = await admin();
    const { data: j } = await db
      .from("omni_jobs")
      .select("id,project_id,kind,status,sent_at,code_request_id,repo,instructions,report_id")
      .eq("id", data.jobId)
      .maybeSingle();
    const job = j as (JobRow & { report_id: string | null }) | null;
    if (!job || !job.project_id) throw new Error("Job not found.");
    const { data: p } = await db.from("agent_projects").select("id,name,repo_url,created_by").eq("id", job.project_id).maybeSingle();
    const proj = p as { id: string; name: string; repo_url: string | null; created_by: string | null } | null;
    if (!proj || proj.created_by !== context.userId) throw new Error("Only your own project's jobs can be copied.");
    const repo = repoFromUrl(proj.repo_url);
    const refusal = jobCopyRefusal(
      { status: job.status, sentAt: job.sent_at, codeRequestId: job.code_request_id, repo: job.repo, kind: job.kind },
      repo,
    );
    if (refusal) throw new Error(refusal);
    const { data: existing } = await db
      .from("omni_jobs")
      .select("id")
      .eq("project_id", proj.id)
      .eq("kind", job.kind)
      .eq("repo", repo)
      .eq("instructions", job.instructions)
      .eq("status", "queued")
      .is("sent_at", null)
      .limit(1);
    if (existing && (existing as unknown[]).length > 0) throw new Error("A copy with this repository is already waiting.");
    const { data: ins, error } = await db
      .from("omni_jobs")
      .insert({
        project_id: proj.id, report_id: job.report_id, kind: job.kind, instructions: job.instructions,
        repo, created_by: context.userId, status: "queued", sent_at: null, guardian_verdict: "pending",
      })
      .select("id")
      .single();
    if (error || !ins) throw new Error("The copy could not be queued.");
    const { logSite } = await import("./site-log.server");
    await logSite({
      actor: context.userId, action: "omni.job.copied", category: "config", status: "pending", repo,
      summary: `Queued a copy of OMNI job ${job.id.slice(0, 8)} for ${repo} (${proj.name}). Original unchanged; nothing sent.`,
    });
    return { id: (ins as { id: string }).id, repo };
  });

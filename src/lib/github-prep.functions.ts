// Owner server functions for GitHub issue/PR preparation. Reads are live from GitHub; the only
// writes are "open issue" and "open draft PR", each pressed by the owner and logged. No merge/deploy.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { parseRepo } from "./repo-workspace";

type Ctx = {
  userId: string;
  supabase: {
    rpc: (f: "my_role") => PromiseLike<{ data: unknown }>;
    from: (t: "owner_projects") => {
      select: (c: string) => { eq: (k: string, v: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }> } };
    };
  };
};

async function target(ctx: Ctx, projectId: string) {
  const { data: role } = await ctx.supabase.rpc("my_role");
  if (role !== "owner") throw new Error("Only the owner can prepare GitHub issues and pull requests.");
  const { data, error } = await ctx.supabase
    .from("owner_projects")
    .select("id, name, github_repo, github_branch")
    .eq("id", projectId)
    .maybeSingle();
  const p = data as { id: string; name: string; github_repo: string | null; github_branch: string | null } | null;
  if (error || !p) throw new Error("Project not found.");
  const repo = parseRepo(p.github_repo);
  if (!repo) throw new Error("This project has no GitHub repository linked.");
  return { ...repo, base: p.github_branch || "main", projectId: p.id, projectName: p.name };
}

const projectOnly = z.object({ projectId: z.string().uuid() }).strict();
const issueInput = z
  .object({
    projectId: z.string().uuid(),
    title: z.string().max(200),
    problem: z.string().max(8000),
    ref: z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/).optional(),
  })
  .strict();
const prInput = z
  .object({
    projectId: z.string().uuid(),
    branch: z.string().max(100),
    title: z.string().max(200),
    summary: z.string().max(8000),
    issueNumber: z.number().int().positive().nullable().optional(),
  })
  .strict();

/** Read-only: open pull requests with CI evidence and review status. */
export const getGitHubPrepStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => projectOnly.parse(d))
  .handler(async ({ context, data }) => {
    const t = await target(context as unknown as Ctx, data.projectId);
    const s = await import("./github-prep.server");
    try {
      const [pulls, baseCi] = await Promise.all([s.pullSummaries(t), s.ciEvidence(t, t.base).catch(() => null)]);
      return { repo: `${t.owner}/${t.repo}`, base: t.base, pulls, baseCi, error: null as string | null };
    } catch (e) {
      return { repo: `${t.owner}/${t.repo}`, base: t.base, pulls: [], baseCi: null, error: (e as Error).message.slice(0, 300) };
    }
  });

export const previewGitHubIssue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => issueInput.parse(d))
  .handler(async ({ context, data }) => {
    const t = await target(context as unknown as Ctx, data.projectId);
    return (await import("./github-prep.server")).previewIssue(t, data.title, data.problem, data.ref);
  });

export const createGitHubIssue = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => issueInput.extend({ confirm: z.literal(true) }).strict().parse(d))
  .handler(async ({ context, data }) => {
    const t = await target(context as unknown as Ctx, data.projectId);
    return (await import("./github-prep.server")).createPreparedIssue(context.userId, t, data.title, data.problem, data.ref);
  });

export const previewGitHubDraftPr = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => prInput.parse(d))
  .handler(async ({ context, data }) => {
    const t = await target(context as unknown as Ctx, data.projectId);
    return (await import("./github-prep.server")).previewDraftPr(t, data.branch, data.title, data.summary, data.issueNumber);
  });

export const openGitHubDraftPr = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => prInput.extend({ confirm: z.literal(true) }).strict().parse(d))
  .handler(async ({ context, data }) => {
    const t = await target(context as unknown as Ctx, data.projectId);
    return (await import("./github-prep.server")).openPreparedDraftPr(
      context.userId, t, data.branch, data.title, data.summary, data.issueNumber,
    );
  });

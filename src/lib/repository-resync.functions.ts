import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { canonicalRepo, listTokenRepositories, reviewReferences, type RepoReference } from "./repository-resync";

function tokenRequest() {
  const token = process.env["GITHUB_TOKEN"];
  if (!token) throw new Error("GITHUB_TOKEN is missing. Add it in Project Settings → Secrets, then resync. The GitHub App is not substituted for this check.");
  return (path: string) => fetch(`https://api.github.com${path}`, { signal: AbortSignal.timeout(15000), headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Jackboy" } });
}
export const resyncRepositories = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  const { data: role } = await context.supabase.rpc("my_role");
  if (role !== "owner") throw new Error("Owner only.");
  const request = tokenRequest();
  const [inventory, user] = await Promise.all([listTokenRepositories(request), request("/user")]);
  if (!user.ok) throw new Error(`GitHub ${user.status}: token identity could not be verified.`);
  const login = String((await user.json() as { login: string }).login);
  const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
  const refs = await db.rpc("repository_reference_inventory");
  if (refs.error) throw new Error(refs.error.message);
  const references = refs.data as unknown as RepoReference[];
  // Approved runner targets are policy, not mappings. Report names only, never credential values.
  const manual: { location: string; repo: string; reason: string }[] = [];
  try { for (const repo of Object.keys(JSON.parse(process.env["CODE_TARGETS"] ?? "{}"))) if (canonicalRepo(repo)) manual.push({ location: "CODE_TARGETS", repo, reason: "Runner ref and workflow SHA require separate owner review; Secrets cannot be rewritten by resync." }); }
  catch { manual.push({ location: "CODE_TARGETS", repo: "invalid configuration", reason: "Invalid JSON; owner must correct it in Project Settings → Secrets." }); }
  manual.push({ location: "github-app.server.ts / PERSONAL_TOKEN_REPOS", repo: "street-tech666/jackboy-dev-control", reason: "Personal-token security allowlist; changing it requires a separately approved code change." });
  const snapshot = await db.from("repository_resync_reviews").insert({ requested_by: context.userId, inventory, references_snapshot: references as never }).select("id,expires_at").single();
  if (snapshot.error) throw new Error(snapshot.error.message);
  await (await import("./site-log.server")).logSite({ actor: `owner:${context.userId}`, action: "repositories.resync.review", category: "inspection", status: "ok", summary: `Token ${login}: ${inventory.length} accessible repositories; replacement review prepared without changing references`, detail: { review: snapshot.data.id } });
  return { id: snapshot.data.id, expiresAt: snapshot.data.expires_at, login, inventory, rows: reviewReferences(references, inventory), manual, scopes: user.headers.get("x-oauth-scopes"), checkedAt: new Date().toISOString() };
});

export const approveRepositoryResync = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ reviewId: z.string().uuid(), grantId: z.string().uuid().optional(), changes: z.array(z.object({ from: z.string().regex(/^[\w.-]+\/[\w.-]+$/), to: z.string().regex(/^[\w.-]+\/[\w.-]+$/) })).min(1).max(100) }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: role } = await context.supabase.rpc("my_role");
    if (role !== "owner") throw new Error("Owner only.");
    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");
    const review = await db.from("repository_resync_reviews").select("requested_by,approved_at,expires_at,inventory,references_snapshot").eq("id", data.reviewId).single();
    if (review.error || review.data.requested_by !== context.userId) throw new Error("Review not found.");
    if (!review.data.approved_at) {
      if (Date.parse(review.data.expires_at) <= Date.now()) throw new Error("Review expired. Resync again.");
      const live = await listTokenRepositories(tokenRequest());
      const rows = reviewReferences(review.data.references_snapshot as unknown as RepoReference[], review.data.inventory as string[]);
      for (const change of data.changes) {
        const row = rows.find(r => r.repo === change.from);
        if (row?.status !== "missing" || !row.references.some(r => r.mutable) || !live.includes(change.to)) throw new Error("Repository choice is stale or not accessible. Resync again.");
      }
      await (await import("./passkey.server")).consumeGrant(data.grantId, context.userId, "approve_integration", `repository_resync:${data.reviewId}`);
    }
    const result = await db.rpc("apply_repository_resync", { review_id: data.reviewId, actor_id: context.userId, changes: data.changes });
    if (result.error) throw new Error(result.error.message);
    return result.data as unknown as { fixed: { from: string; to: string }[]; references: number; alreadyApplied: boolean };
  });
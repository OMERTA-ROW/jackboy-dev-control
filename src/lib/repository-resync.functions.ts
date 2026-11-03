import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { needsRepositoryCheck, type RepositoryReviewRow } from "./repository-resync";
export type ResyncReport = { login: string; scopes: string[]; permissions: Record<string, string>; warning: string | null; rows: RepositoryReviewRow[]; inventoryCount: number };
export type ResyncReview = { id: string; created_at: string; expires_at: string; approved_at: string | null; invalidated: boolean; report: ResyncReport };
export const checkRepositorySync = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ force: z.boolean().optional() }).parse(d))
  .handler(async ({ data, context }): Promise<ResyncReview> => {
    const { data: role } = await context.supabase.rpc("my_role");
    if (role !== "owner") throw new Error("Owner only.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: last, error } = await supabaseAdmin.from("repository_resync_reviews").select("id,created_at,expires_at,approved_at,report,invalidated").eq("requested_by", context.userId).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data.force && last?.report && !last.approved_at && !needsRepositoryCheck(last.created_at, last.invalidated)) return last as unknown as ResyncReview;
    return await (await import("./repository-resync.server")).scanRepositories(context.userId) as unknown as ResyncReview;
  });
export const approveRepositorySync = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ reviewId: z.string().uuid(), grantId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: role } = await context.supabase.rpc("my_role");
    if (role !== "owner") throw new Error("Owner only.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: review, error } = await supabaseAdmin.from("repository_resync_reviews").select("report,approved_at").eq("id", data.reviewId).eq("requested_by", context.userId).single();
    if (error) throw new Error(error.message);
    if (review.approved_at) return { alreadyApplied: true };
    const rows = (review.report as unknown as ResyncReport).rows;
    const changes = rows.filter((r) => r.canApply && r.group !== "linked").map((r) => ({ from: r.repo, to: r.proposed, profiles: r.profiles ?? [] }));
    if (!changes.length) throw new Error("No verified changes are ready for approval.");
    await (await import("./passkey.server")).consumeGrant(data.grantId, context.userId, "approve_integration", `repository_resync:${data.reviewId}`);
    const result = await supabaseAdmin.rpc("apply_project_repository_resync", { review_id: data.reviewId, actor_id: context.userId, changes });
    if (result.error) throw new Error(result.error.message);
    return result.data;
  });
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
export const verifyProjectPermissions = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ projectId: z.string().uuid().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: role } = await context.supabase.rpc("my_role");
    if (role !== "owner") throw new Error("Owner only.");
    const { checkProjectPermissions } = await import("./project-permissions.server");
    if (data.projectId) return [{ projectId: data.projectId, evidence: await checkProjectPermissions(data.projectId, `owner:${context.userId}`), error: null }];
    const rows = await context.supabase.from("owner_projects").select("id").not("github_repo", "is", null);
    if (rows.error) throw new Error(rows.error.message);
    const results = [];
    for (const row of rows.data ?? []) {
      try { results.push({ projectId: row.id, evidence: await checkProjectPermissions(row.id, `owner:${context.userId}`), error: null }); }
      catch (e) { results.push({ projectId: row.id, evidence: null, error: e instanceof Error ? e.message : "Permission check failed" }); }
    }
    return results;
  });
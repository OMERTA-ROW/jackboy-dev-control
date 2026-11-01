import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Owner-only: check one or more projects' site addresses now (bounded to 20). */
export const checkSites = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ ids: z.array(z.string().uuid()).min(1).max(20) }).parse(d))
  .handler(async ({ data, context }) => {
    const { data: role } = await context.supabase.rpc("my_role");
    if (role !== "owner") throw new Error("Owner only.");
    const { data: rows, error } = await context.supabase.from("owner_projects").select("id,site_url,site_fail_count,site_status").in("id", data.ids);
    if (error) throw new Error(error.message);
    const { checkAndStore } = await import("./site-monitor.server");
    const out = [];
    for (const p of rows ?? []) out.push(await checkAndStore(context.supabase, p, context.userId));
    return out.map((r) => ({ id: r.id, status: r.status, reason: r.evidence.reason }));
  });

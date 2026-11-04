import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function requireOwner(ctx: { supabase: { rpc: (f: "my_role") => PromiseLike<{ data: unknown }> } }) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Only the owner can manage the OMNI link.");
}

export const getOmniLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const { omniConfigState } = await import("./omni-link.server");
    const [conn, jobs] = await Promise.all([
      context.supabase.from("omni_connection").select("*").eq("id", true).maybeSingle(),
      context.supabase.from("omni_jobs").select("id, kind, status, repo, attempts, last_error, sent_at, completed_at, pr_url, created_at, code_request_id, instructions").order("created_at", { ascending: false }).limit(25),
    ]);
    return { config: omniConfigState(), connection: conn.data, jobs: (jobs.data ?? []).map((j) => ({ ...j, instructions: j.instructions.slice(0, 160) })) };
  });

export const runOmniHandshake = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const { omniHandshake } = await import("./omni-link.server");
    return omniHandshake(context.userId);
  });

/** Read-only check of the reviewed OMNI-initiated link (omni.link/v2, PR #3 design).
 * OMNI calls Jackboy, so Jackboy never calls OMNI here; it never sends work or reads secret values. */
export const probeOmniConnection = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const { linkConfig } = await import("./omni-session.server");
    const { reverseLinkReport, REVERSE_LINK_VARS } = await import("./omni-link-readiness");
    const env = Object.fromEntries(REVERSE_LINK_VARS.map((n) => [n, process.env[n]]));
    const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const { data, error } = await db.from("omni_link_sessions").select("expires_at").order("expires_at", { ascending: false }).limit(1);
    const rows = (data ?? []) as { expires_at: string }[];
    const report = reverseLinkReport({ env, configValid: linkConfig() !== null, storageReady: !error, lastSessionAt: rows[0]?.expires_at ?? null });
    return { ...report, error: report.verified ? null : report.missing.join(" · ") };
  });

export const dispatchOmniNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const { dispatchOmniJobs } = await import("./omni-link.server");
    return dispatchOmniJobs();
  });

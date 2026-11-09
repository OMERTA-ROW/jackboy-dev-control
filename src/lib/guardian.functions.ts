import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  AUDIT_ACTIONS,
  SITE_ACTIONS,
  classifyAudit,
  classifySite,
  guardianStatus,
  mergeEvents,
  validLimits,
} from "./guardian-overview";
import { untyped } from "./untyped-db";

type Ctx = {
  supabase: { rpc: (name: "my_role") => PromiseLike<{ data: unknown }> };
  userId: string;
};
async function role(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (!data) throw new Error("Forbidden: Jackboy access requires an accepted invitation.");
  return data as "owner" | "admin" | "member";
}

/** Read-only Guardian overview built from real policy, agent and log records. */
export const getGuardianOverview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const r = await role(context);
    const [pol, ag, audit, site] = await Promise.all([
      context.supabase
        .from("automation_policy")
        .select("paused, tier, max_files, max_lines, guardian_verified, updated_at")
        .eq("id", 1)
        .maybeSingle(),
      context.supabase.from("agents").select("paused, passport_approved"),
      context.supabase
        .from("audit_logs")
        .select("id, at, action, outcome, detail")
        .in("action", [...AUDIT_ACTIONS])
        .order("at", { ascending: false })
        .limit(60),
      context.supabase
        .from("site_log")
        .select("id, at, action, status, summary")
        .in("action", [...SITE_ACTIONS])
        .order("at", { ascending: false })
        .limit(60),
    ]);
    const p = pol.error ? null : pol.data;
    const agents = (ag.data ?? []) as Array<{ paused: boolean; passport_approved: boolean }>;
    return {
      role: r,
      status: guardianStatus(p, Boolean(p?.guardian_verified)),
      policy: p
        ? {
            tier: p.tier as 0 | 1 | 2,
            maxFiles: p.max_files as number,
            maxLines: p.max_lines as number,
            guardianVerified: Boolean(p.guardian_verified),
            killSwitch: Boolean(p.paused),
            updatedAt: p.updated_at as string | null,
          }
        : null,
      agents: {
        total: agents.length,
        paused: agents.filter((a) => a.paused).length,
        approved: agents.filter((a) => a.passport_approved).length,
      },
      activity: mergeEvents([
        (audit.data ?? []).map(classifyAudit),
        (site.data ?? []).map(classifySite),
      ]),
      logErrors: [audit.error, site.error].flatMap((e) => (e ? [e.message as string] : [])),
      observedAt: new Date().toISOString(),
    };
  });

/** Owner-only atomic limit update; the database never writes the pause column. */
export const setGuardianLimits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        tier: z.number().int().min(0).max(2),
        maxFiles: z.number().int().min(1).max(20),
        maxLines: z.number().int().min(1).max(500),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    if ((await role(context)) !== "owner")
      throw new Error("Only the owner can change Guardian settings.");
    const bad = validLimits(data);
    if (bad) throw new Error(bad);
    const { error } = await untyped(context.supabase).rpc("set_guardian_limits", {
      _tier: data.tier,
      _max_files: data.maxFiles,
      _max_lines: data.maxLines,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

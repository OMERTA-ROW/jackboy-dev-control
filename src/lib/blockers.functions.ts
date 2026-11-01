// Owner-only blocker queue API. Approval of external-provider scopes needs a fresh passkey step-up,
// is then followed automatically by a real provider check; a pass resumes the waiting Foundry work.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { approvalTarget, capRisk, deriveBlockers } from "./blockers";

async function owner(ctx: { supabase: { rpc: (n: "my_role") => PromiseLike<{ data: unknown }> }; userId: string }) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Owner only.");
  return `owner:${ctx.userId}`;
}

export const getBlockers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await owner(context as never);
    await (await import("./autoconnect.server")).scanCapabilities(); // diagnose: record what each connected project is missing
    const [p, g, t, h] = await Promise.all([
      context.supabase.from("owner_projects").select("id, name, github_repo, dev_enabled, active"),
      context.supabase.from("capability_grants").select("capability, project_id, status, paused, expires_at, last_error"),
      context.supabase.from("foundry_tasks").select("id, project_id, title, state, needs_capability, blocked_reason").in("state", ["blocked", "awaiting_approval", "testing"]),
      context.supabase.from("site_log").select("id, created_at, action, status, summary, project_id").in("action", ["capability_approved", "capability_verified", "blocker_resolved", "foundry.resumed_tests"]).order("created_at", { ascending: false }).limit(30),
    ]);
    return { blockers: deriveBlockers((p.data ?? []) as never, (g.data ?? []) as never, (t.data ?? []) as never), history: h.data ?? [] };
  });

export const actOnBlocker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { cap: string; projectId: string; op: "approve" | "verify"; grantId?: string }) => {
    if (!/^[a-z_]{3,40}$/.test(d.cap) || !/^[0-9a-f-]{36}$/i.test(d.projectId) || !["approve", "verify"].includes(d.op)) throw new Error("Bad input.");
    return d;
  })
  .handler(async ({ data, context }) => {
    const actor = await owner(context as never);
    const s = await import("./autoconnect.server");
    if (data.op === "approve") {
      if (capRisk(data.cap) === "Critical") await (await import("./passkey.server")).consumeGrant(data.grantId, context.userId, "approve_integration", approvalTarget(data.cap, data.projectId));
      const a = await s.approveCapability(data.cap, data.projectId, actor, context.userId);
      if (a.status === "unavailable") return { status: a.status, detail: "No supported connection exists for this yet.", resumed: 0 };
    }
    const r = await s.verifyCapability(data.cap, data.projectId, actor); // real provider call
    if (r.status === "connected") {
      const { logSite } = await import("./site-log.server");
      await logSite({ actor, action: "blocker_resolved", category: "config", status: "ok", project_id: data.projectId, summary: `Blocker cleared: ${data.cap} verified (${r.detail}). Resumed ${r.resumed} waiting task(s).` });
    }
    return r;
  });

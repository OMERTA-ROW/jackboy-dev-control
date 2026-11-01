// Owner-only AutoConnect API.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function owner(ctx: { supabase: { rpc: (n: "my_role") => PromiseLike<{ data: unknown }> }; userId: string }) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Owner only.");
  return `owner:${ctx.userId}`;
}
const CAP_RE = /^[a-z_]{3,40}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

export const getAutoConnect = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await owner(context as never);
    const s = await import("./autoconnect.server");
    await s.scanCapabilities();
    const [g, p, t] = await Promise.all([
      context.supabase.from("capability_grants").select("*").order("capability"),
      context.supabase.from("owner_projects").select("id, name, github_repo"),
      context.supabase.from("foundry_tasks").select("id, project_id, title, needs_capability").not("needs_capability", "is", null),
    ]);
    return { grants: g.data ?? [], projects: p.data ?? [], waiting: t.data ?? [] };
  });

export const autoConnectAct = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { cap: string; projectId: string; op: "approve" | "verify" | "pause" | "resume" | "revoke" }) => {
    if (!CAP_RE.test(d.cap) || !UUID_RE.test(d.projectId)) throw new Error("Bad input.");
    if (!["approve", "verify", "pause", "resume", "revoke"].includes(d.op)) throw new Error("Bad op.");
    return d;
  })
  .handler(async ({ data, context }) => {
    const actor = await owner(context as never);
    const s = await import("./autoconnect.server");
    if (data.op === "approve") return s.approveCapability(data.cap, data.projectId, actor, context.userId);
    if (data.op === "verify") return s.verifyCapability(data.cap, data.projectId, actor);
    await s.setGrant(data.cap, data.projectId, actor, data.op);
    return { ok: true };
  });

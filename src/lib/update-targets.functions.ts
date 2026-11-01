// Owner-only updater inventory: enroll a target (token shown once), list targets with install history, revoke.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

type Ctx = { supabase: any; userId: string };
async function owner(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Owner only.");
}

export const listTargets = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth]).handler(async ({ context }) => {
  await owner(context);
  const [t, i] = await Promise.all([
    context.supabase.from("update_targets").select("id, project_id, name, channel, platform, current_version, state, last_seen_at, revoked_at, created_at").order("created_at", { ascending: false }),
    context.supabase.from("update_installs").select("id, target_id, version, phase, detail, created_at").order("created_at", { ascending: false }).limit(100),
  ]);
  return { targets: (t.data ?? []) as any[], installs: (i.data ?? []) as any[] };
});

export const enrollTarget = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ project_id: z.string().uuid(), name: z.string().trim().min(1).max(120), channel: z.enum(["test", "beta", "live"]), platform: z.string().trim().min(1).max(40).regex(/^[a-z0-9_-]+$/) }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { sha256Hex } = await import("./update-targets.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const token = "jbt_" + Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
    const { error } = await supabaseAdmin.from("update_targets").insert({ ...data, token_hash: await sha256Hex(token), created_by: context.userId });
    if (error) throw new Error(error.message);
    await context.supabase.rpc("write_audit", { _action: "updater.enroll", _detail: { project_id: data.project_id, name: data.name, channel: data.channel }, _outcome: "ok" });
    return { token }; // shown once; only the hash is stored
  });

export const revokeTarget = createServerFn({ method: "POST" }).middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await owner(context);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("update_targets").update({ revoked_at: new Date().toISOString(), state: "revoked" }).eq("id", data.id);
    await context.supabase.rpc("write_audit", { _action: "updater.revoke", _detail: { id: data.id }, _outcome: "ok" });
    return { ok: true };
  });

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Account/onboarding status for the signed-in user. Never reveals the owner email. */
export const getAccountStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: role } = await context.supabase.rpc("my_role");
    const ownerConfigured = Boolean(process.env["OWNER_EMAIL"]);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { count } = await supabaseAdmin.from("user_roles").select("id", { count: "exact", head: true }).eq("role", "owner");
    return { role: (role as string | null) ?? null, ownerConfigured, ownerExists: (count ?? 0) > 0 };
  });

/** Owner bootstrap: only a confirmed email matching the OWNER_EMAIL server secret, only while no owner exists. */
export const claimOwner = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const ownerEmail = process.env["OWNER_EMAIL"]?.trim().toLowerCase();
    if (!ownerEmail) throw new Error("Owner email has not been configured yet.");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: u } = await supabaseAdmin.auth.admin.getUserById(context.userId);
    const email = u.user?.email?.toLowerCase();
    const audit = (outcome: string) =>
      supabaseAdmin.from("audit_logs").insert({ actor: context.userId, action: "owner.claim", outcome, detail: {} });
    if (!u.user?.email_confirmed_at || email !== ownerEmail) {
      await audit("denied");
      throw new Error("This account is not the configured owner.");
    }
    const { count } = await supabaseAdmin.from("user_roles").select("id", { count: "exact", head: true }).eq("role", "owner");
    if ((count ?? 0) > 0) {
      await audit("denied");
      throw new Error("An owner already exists.");
    }
    const { error } = await supabaseAdmin.from("user_roles").insert({ user_id: context.userId, role: "owner" });
    if (error) throw new Error("Could not assign owner role.");
    await audit("ok");
    return { role: "owner" };
  });

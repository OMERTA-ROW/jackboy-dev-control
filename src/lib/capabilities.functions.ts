import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getTesterCapabilities = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: role } = await context.supabase.rpc("my_role");
    if (role !== "owner") throw new Error("Only the owner can view capability status.");
    const [{ jackboyManifest }, { toTester }, { supabaseAdmin }] = await Promise.all([
      import("./agent-manifest.server"), import("./capabilities"), import("@/integrations/supabase/client.server"),
    ]);
    const [m, pol, sch, aw] = await Promise.all([
      jackboyManifest(),
      supabaseAdmin.from("automation_policy").select("paused").limit(1).maybeSingle(),
      supabaseAdmin.from("foundry_schedule").select("enabled").limit(1).maybeSingle(),
      supabaseAdmin.from("update_writer_settings").select("autopilot_enabled").limit(1).maybeSingle(),
    ]);
    const safety = { emergencyPause: pol.data?.paused ?? true, schedules: sch.data?.enabled ?? false, autopilot: aw.data?.autopilot_enabled ?? false };
    return { safety, capabilities: toTester(m, safety), generatedAt: m.generatedAt };
  });

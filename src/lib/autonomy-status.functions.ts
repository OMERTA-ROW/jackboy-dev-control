import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Owner-only, read-only snapshot for "What's really running". Never changes a switch or starts work.
export const getAutonomyStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: role } = await context.supabase.rpc("my_role");
    if (role !== "owner") throw new Error("Only the owner can view autonomy status.");
    const [{ supabaseAdmin }, { untyped }, { summarizeAutonomy }] = await Promise.all([
      import("@/integrations/supabase/client.server"), import("./untyped-db"), import("./autonomy-status"),
    ]);
    const db = untyped(supabaseAdmin);
    const [pol, projects, uws, fs, site, beat, code, omni] = await Promise.all([
      supabaseAdmin.from("automation_policy").select("paused").eq("id", 1).maybeSingle(),
      supabaseAdmin.from("owner_projects").select("name, github_repo, dev_enabled, autopilot").eq("active", true).order("name"),
      supabaseAdmin.from("update_writer_settings").select("autopilot_enabled, paused_reason, last_run_at").eq("id", 1).maybeSingle(),
      supabaseAdmin.from("foundry_schedule").select("enabled, paused, last_tick_at").eq("id", 1).maybeSingle(),
      supabaseAdmin.from("owner_projects").select("site_checked_at").not("site_checked_at", "is", null).order("site_checked_at", { ascending: false }).limit(1).maybeSingle(),
      supabaseAdmin.from("site_log").select("at").eq("action", "owner_alerts.heartbeat").order("at", { ascending: false }).limit(1).maybeSingle(),
      db.from("code_runtime_controls").select("enabled, kill_switch, provider_hard_cap_verified, spend_meter, consecutive_failures, active_request_id, allowed_targets").limit(1).maybeSingle(),
      supabaseAdmin.from("omni_connection").select("verified").limit(1).maybeSingle(),
    ]);
    const c = code.data as Record<string, unknown> | null;
    const meter = (c?.["spend_meter"] ?? null) as { ok?: unknown } | null;
    const summary = summarizeAutonomy({
      now: Date.now(),
      killSwitch: pol.error || typeof pol.data?.paused !== "boolean" ? null : pol.data.paused,
      projects: (projects.data ?? []).map((p) => ({ name: p.name, repo: p.github_repo, devEnabled: Boolean(p.dev_enabled), autopilot: Boolean(p.autopilot) })),
      autopilotMaster: Boolean(uws.data?.autopilot_enabled),
      pauseReason: uws.data?.paused_reason ?? null,
      foundry: fs.data ? { enabled: Boolean(fs.data.enabled), paused: Boolean(fs.data.paused), lastTickAt: fs.data.last_tick_at ?? null } : null,
      updateWriterLastRunAt: uws.data?.last_run_at ?? null,
      siteCheckedAt: (site.data as { site_checked_at?: string | null } | null)?.site_checked_at ?? null,
      alertsHeartbeatAt: beat.data?.at ?? null,
      code: c && !code.error ? {
        enabled: c["enabled"] === true, killSwitch: c["kill_switch"] !== false, hardCap: c["provider_hard_cap_verified"] === true,
        meterOk: typeof meter?.ok === "boolean" ? meter.ok : null, failures: Number(c["consecutive_failures"] ?? 0),
        activeRun: Boolean(c["active_request_id"]), targets: Object.keys((c["allowed_targets"] ?? {}) as Record<string, unknown>),
      } : null,
      omniVerified: omni.data?.verified === true,
    });
    return { ...summary, observedAt: new Date().toISOString() };
  });

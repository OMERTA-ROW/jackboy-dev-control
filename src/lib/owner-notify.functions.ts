// Owner-only server functions for Reports, phone alerts and CODE Undo.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { localDate, validTimezone } from "./owner-alerts";

type Ctx = { supabase: { rpc: (f: "my_role") => PromiseLike<{ data: unknown }> }; userId: string };
async function requireOwner(ctx: Ctx) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Only the owner can use reports, alerts and Undo.");
}
const admin = async () => (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);

export const getReportsPage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const a = await import("./owner-alerts.server");
    const db = await admin();
    const settings = await a.getAlertSettings();
    const [reports, alerts, devices] = await Promise.all([
      db.from("daily_reports").select("report_date, generated_at, summary").order("report_date", { ascending: false }).limit(14),
      db.from("owner_alert_outbox").select("id, kind, title, body, status, last_error, created_at, sent_at, reminder, urgent").order("created_at", { ascending: false }).limit(30),
      db.from("push_devices").select("id, label, active, created_at, last_sent_at, last_error").eq("user_id", context.userId).order("created_at", { ascending: false }),
    ]);
    let preview: { summary: string } | null = null, previewError: string | null = null;
    try { preview = { summary: (await (await import("./daily-report.server")).composeReport(localDate(Date.now(), settings.timezone))).summary }; }
    catch (e) { previewError = e instanceof Error ? e.message : "The report preview could not be built."; }
    return {
      settings,
      pushConfigured: a.pushConfigured(),
      reports: (reports.data ?? []) as { report_date: string; generated_at: string; summary: string }[],
      alerts: (alerts.data ?? []) as { id: string; kind: string; title: string; body: string; status: string; last_error: string | null; created_at: string; sent_at: string | null; reminder: boolean; urgent: boolean }[],
      devices: (devices.data ?? []) as { id: string; label: string; active: boolean; created_at: string; last_sent_at: string | null; last_error: string | null }[],
      preview,
      previewError,
    };
  });

const hour = z.number().int().min(0).max(23);
export const saveAlertSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ timezone: z.string().min(3).max(64).refine(validTimezone, "Unknown time zone"), reportHour: hour, alertsEnabled: z.boolean(), quietStart: hour.nullable(), quietEnd: hour.nullable() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    await (await import("./owner-alerts.server")).saveAlertSettings(data, context.userId);
    return { ok: true };
  });

export const registerPushDevice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ token: z.string().min(20).max(4096), label: z.string().trim().min(1).max(80) }).parse(d))
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    const db = await admin();
    const { error } = await db.from("push_devices").upsert({ token: data.token, user_id: context.userId, label: data.label, active: true, last_error: null }, { onConflict: "token" });
    if (error) throw new Error("This device could not be registered.");
    await db.from("audit_logs").insert({ actor: context.userId, action: "alerts.device_registered", detail: { label: data.label }, outcome: "ok" });
    return { ok: true };
  });

export const removePushDevice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    const db = await admin();
    const { error } = await db.from("push_devices").delete().eq("id", data.id).eq("user_id", context.userId);
    if (error) throw new Error("The device could not be removed.");
    return { ok: true };
  });

export const sendTestAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    return (await import("./owner-alerts.server")).sendTestAlert();
  });

export const retryAlert = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    return (await import("./owner-alerts.server")).retryAlert(data.id);
  });

export const sendReportNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    return (await import("./daily-report.server")).runDailyReport(Date.now(), true);
  });

export const listUndoable = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    return (await import("./code-undo.server")).listUndoable();
  });

export const getUndoState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ requestId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    return (await import("./code-undo.server")).getUndoState(data.requestId);
  });

export const undoCodeChange = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ requestId: z.string().uuid(), grantId: z.string().uuid().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    return (await import("./code-undo.server")).undoCode(data.requestId, context.userId, data.grantId);
  });

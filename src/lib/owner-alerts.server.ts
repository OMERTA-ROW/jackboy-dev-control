// Phone alerts runtime: finds what's waiting from real records, queues deduplicated alerts and sends them as
// push notifications through Firebase Cloud Messaging (connector gateway). Rules live in owner-alerts.ts.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { DEFAULT_ALERT_SETTINGS, MAX_SEND_ATTEMPTS, draftAlert, localDate, reminderFor, retryable, sendDecision, tokenIsDead, type AlertDraft, type AlertKind, type AlertSettings } from "./owner-alerts";
import { untyped } from "./untyped-db";

const db = () => untyped(supabaseAdmin);
const GATEWAY_URL = "https://connector-gateway.lovable.dev/firebase_messaging";
/** Push taps open the published site; the link path is always relative to it. */
const SITE_ORIGIN = "https://jackboy-dev-control.lovable.app";

export function pushConfigured(): boolean {
  return Boolean(process.env["LOVABLE_API_KEY"] && process.env["FIREBASE_MESSAGING_API_KEY"]);
}

export async function getAlertSettings(): Promise<AlertSettings> {
  const { data } = await db().from("owner_alert_settings").select("*").eq("singleton", true).maybeSingle();
  if (!data) return DEFAULT_ALERT_SETTINGS;
  const d = data as { timezone: string; report_hour: number; alerts_enabled: boolean; quiet_start: number | null; quiet_end: number | null };
  return { timezone: d.timezone, reportHour: d.report_hour, alertsEnabled: d.alerts_enabled, quietStart: d.quiet_start, quietEnd: d.quiet_end };
}
export async function saveAlertSettings(s: AlertSettings, userId: string) {
  const { error } = await db().from("owner_alert_settings").upsert({ singleton: true, timezone: s.timezone, report_hour: s.reportHour, alerts_enabled: s.alertsEnabled, quiet_start: s.quietStart, quiet_end: s.quietEnd, updated_at: new Date().toISOString(), updated_by: userId });
  if (error) throw new Error("Alert settings could not be saved.");
}

/** Queues alerts; an existing dedupe key is left alone, so each item alerts once. */
export async function enqueueAlerts(drafts: AlertDraft[]) {
  if (!drafts.length) return 0;
  const rows = drafts.map((d) => ({ dedupe_key: d.dedupeKey, kind: d.kind, urgent: d.urgent, title: d.title, body: d.body, link: d.link, reminder: Boolean(d.reminder) }));
  const { data, error } = await db().from("owner_alert_outbox").upsert(rows, { onConflict: "dedupe_key", ignoreDuplicates: true }).select("id");
  if (error) throw new Error(`Alerts could not be queued: ${error.message}`);
  return (data ?? []).length;
}

/** Everything currently waiting for the owner, from real records. Each source fails on its own. */
export async function waitingItems(): Promise<{ drafts: AlertDraft[]; complete: boolean }> {
  const drafts: AlertDraft[] = [];
  let complete = true;
  try {
    const scan = await (await import("./code.server")).codeWaitingScan();
    for (const p of scan.pending) drafts.push(draftAlert("passkey_needed", `code:${p.id}`, `CODE request waiting for your OK`, `${p.repo}: a CODE request is waiting for Allow or Deny in Jackboy.`, "/chat"));
    for (const g of scan.githubWaiting) drafts.push(draftAlert("github_approval", `code:${g.id}`, `CODE run waiting for GitHub approval`, `${g.repo}: the run is paused until you approve it in GitHub.`, "/chat"));
    for (const p of scan.prReady) drafts.push(draftAlert("pr_ready", `code:${p.id}`, `Draft PR ready to review`, `${p.repo}: a CODE run finished and its draft PR is ready.`, "/chat"));
  } catch { complete = false; }
  try {
    const { data, error } = await supabaseAdmin.from("task_steps").select("id, why, tool").eq("status", "waiting").limit(10);
    if (error) throw error;
    for (const s of data ?? []) drafts.push(draftAlert("passkey_needed", `task_step:${s.id}`, "Task step needs your passkey", `${s.why || s.tool}`.slice(0, 300), "/tasks"));
  } catch { complete = false; }
  try {
    const { getCodeSafetyState } = await import("./code-safety.server");
    const s = await getCodeSafetyState();
    const day = localDate(Date.now(), "UTC");
    if (s.consecutiveFailures >= 2) drafts.push(draftAlert("auto_stop", `failures:${day}`, "CODE stopped after two failures", "Two CODE runs failed in a row, so CODE stopped itself. Review before turning it back on.", "/settings#activation"));
    if (s.usageSpike) drafts.push(draftAlert("auto_stop", `spike:${day}`, "CODE stopped: spending spike", "A spending spike was recorded and CODE stopped. Review spending before resuming.", "/settings#activation"));
    for (const reason of s.spendMeter?.reasons ?? []) {
      if (["daily_limit", "hourly_spike", "recent_overrun", "bypass_suspected"].includes(reason)) {
        const { meterReasonText } = await import("./code-safety");
        drafts.push(draftAlert("spend_warning", `${reason}:${day}`, "CODE spending warning", `CODE is blocked because ${meterReasonText(reason)}.`, "/settings#activation"));
      }
    }
  } catch { complete = false; }
  return { drafts, complete };
}

/** Queues new alerts plus one reminder for items still waiting 15 minutes after their alert. */
export async function collectAlerts() {
  const { drafts, complete } = await waitingItems();
  let queued = await enqueueAlerts(drafts);
  const waitingKeys = new Set(drafts.map((d) => d.dedupeKey));
  const { data: sent } = await db().from("owner_alert_outbox").select("dedupe_key, kind, title, body, link, sent_at, reminder").eq("status", "sent").eq("reminder", false).in("kind", ["passkey_needed", "github_approval"]).gte("sent_at", new Date(Date.now() - 24 * 3600_000).toISOString()).limit(50);
  const reminders = ((sent ?? []) as { dedupe_key: string; kind: AlertKind; title: string; body: string; link: string; sent_at: string | null; reminder: boolean }[])
    .map((a) => reminderFor({ dedupeKey: a.dedupe_key, kind: a.kind, title: a.title, body: a.body, link: a.link, sentAt: a.sent_at, reminder: a.reminder }, waitingKeys.has(a.dedupe_key)))
    .filter((a): a is AlertDraft => a !== null);
  queued += await enqueueAlerts(reminders);
  return { queued, complete };
}

type Device = { id: string; token: string };
async function sendPush(device: Device, a: { title: string; body: string; link: string }): Promise<{ ok: true } | { ok: false; status: number; body: string }> {
  const res = await fetch(`${GATEWAY_URL}/v1/projects/_/messages:send`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
    headers: { Authorization: `Bearer ${process.env["LOVABLE_API_KEY"]}`, "X-Connection-Api-Key": process.env["FIREBASE_MESSAGING_API_KEY"]!, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { token: device.token, notification: { title: a.title, body: a.body }, data: { link: a.link }, webpush: { fcm_options: { link: `${SITE_ORIGIN}${a.link}` } } } }),
  });
  if (res.ok) return { ok: true };
  return { ok: false, status: res.status, body: (await res.text()).slice(0, 500) };
}

/** Sends pending alerts to every active device. Never marks an alert sent unless a device accepted it. */
export async function flushAlerts(limit = 20) {
  const settings = await getAlertSettings();
  const dayStart = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { count } = await db().from("owner_alert_outbox").select("id", { count: "exact", head: true }).eq("status", "sent").gte("sent_at", dayStart);
  let sentToday = count ?? 0;
  const { data: pending } = await db().from("owner_alert_outbox").select("*").eq("status", "pending").order("urgent", { ascending: false }).order("created_at").limit(limit);
  const alerts = (pending ?? []) as { id: string; kind: AlertKind; urgent: boolean; title: string; body: string; link: string; attempts: number; created_at: string }[];
  if (!alerts.length) return { sent: 0, failed: 0, held: 0 };
  const { data: devs } = await db().from("push_devices").select("id, token").eq("active", true);
  const devices = (devs ?? []) as Device[];
  let sent = 0, failed = 0, held = 0;
  for (const a of alerts) {
    // Old "waiting" alerts that never went out are dropped instead of arriving late and confusing.
    if (!a.urgent && Date.now() - Date.parse(a.created_at) > 6 * 3600_000) { await db().from("owner_alert_outbox").update({ status: "skipped", last_error: "Expired before it could be sent." }).eq("id", a.id); continue; }
    const d = sendDecision(a, settings, sentToday);
    if (!d.send) {
      if (d.hold) { held++; continue; }
      await db().from("owner_alert_outbox").update({ status: "skipped", last_error: d.reason }).eq("id", a.id);
      continue;
    }
    if (!pushConfigured() || !devices.length) {
      await db().from("owner_alert_outbox").update({ status: "failed", attempts: a.attempts + 1, last_error: !pushConfigured() ? "Push notifications aren't connected yet." : "No phone is registered for alerts yet." }).eq("id", a.id);
      failed++;
      continue;
    }
    let delivered = false, lastError = "", retry = false;
    for (const dev of devices) {
      try {
        const r = await sendPush(dev, a);
        if (r.ok) { delivered = true; await db().from("push_devices").update({ last_sent_at: new Date().toISOString(), last_error: null }).eq("id", dev.id); continue; }
        lastError = `Push service said ${r.status}: ${r.body}`.slice(0, 500);
        if (tokenIsDead(r.status, r.body)) await db().from("push_devices").update({ active: false, last_error: "This device stopped accepting notifications. Register it again." }).eq("id", dev.id);
        else { retry = retry || retryable(r.status); await db().from("push_devices").update({ last_error: lastError }).eq("id", dev.id); }
      } catch (e) { lastError = e instanceof Error ? e.message : String(e); retry = true; }
    }
    const attempts = a.attempts + 1;
    if (delivered) { sent++; sentToday++; await db().from("owner_alert_outbox").update({ status: "sent", attempts, sent_at: new Date().toISOString(), last_error: null }).eq("id", a.id); }
    else { failed++; await db().from("owner_alert_outbox").update({ status: retry && attempts < MAX_SEND_ATTEMPTS ? "pending" : "failed", attempts, last_error: lastError || "No device accepted the notification." }).eq("id", a.id); }
  }
  return { sent, failed, held };
}

/** Owner's Retry: puts a failed alert back in the queue (fresh attempt count) and sends now. */
export async function retryAlert(id: string) {
  const { data } = await db().from("owner_alert_outbox").update({ status: "pending", attempts: 0, last_error: null }).eq("id", id).in("status", ["failed", "skipped"]).select("id").maybeSingle();
  if (!data) throw new Error("That alert can't be retried.");
  return flushAlerts(5);
}

export async function sendTestAlert() {
  const key = `test:${Date.now()}`;
  await enqueueAlerts([draftAlert("test", key, "Jackboy test alert", "Push alerts work on this device. Tapping opens Reports.", "/reports")]);
  const r = await flushAlerts(5);
  const { data } = await db().from("owner_alert_outbox").select("status, last_error").eq("dedupe_key", `test:${key}`).maybeSingle();
  const row = data as { status: string; last_error: string | null } | null;
  return { delivered: row?.status === "sent", error: row?.last_error ?? null, flushed: r };
}

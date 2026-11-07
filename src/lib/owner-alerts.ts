// Phone alert rules (pure, tested). Alerts only point the owner at a page; nothing in a message can approve,
// start or change anything. Every alert is deduplicated, gets at most one reminder, and respects a daily cap.

export type AlertKind = "passkey_needed" | "github_approval" | "auto_stop" | "spend_warning" | "pr_ready" | "daily_report" | "test";
export type AlertDraft = { dedupeKey: string; kind: AlertKind; urgent: boolean; title: string; body: string; link: string; reminder?: boolean };
export type AlertSettings = { timezone: string; reportHour: number; alertsEnabled: boolean; quietStart: number | null; quietEnd: number | null };

export const DEFAULT_ALERT_SETTINGS: AlertSettings = { timezone: "America/New_York", reportHour: 7, alertsEnabled: true, quietStart: null, quietEnd: null };
export const DAILY_ALERT_CAP = 30;
export const REMINDER_AFTER_MS = 15 * 60_000;
export const MAX_SEND_ATTEMPTS = 3;
/** Stops and spend problems always come through, even in quiet hours. */
export const URGENT_KINDS: readonly AlertKind[] = ["auto_stop", "spend_warning"];
/** Only "still waiting for you" alerts get a reminder. */
export const REMINDER_KINDS: readonly AlertKind[] = ["passkey_needed", "github_approval"];

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
/** Links stay on this site: a relative path only, never an outside address. */
export function safeLink(link: string): string {
  return /^\/(?!\/)[\w\-./?=&%#]*$/.test(link) && link.length <= 300 ? link : "/";
}
/** Strips anything that looks like a token, key or email before it can leave in a message. */
export function scrubText(s: string): string {
  return s
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|sk-[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[hidden]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]");
}

export function draftAlert(kind: AlertKind, id: string, title: string, body: string, link: string): AlertDraft {
  return {
    dedupeKey: clip(`${kind}:${id}`, 200),
    kind,
    urgent: URGENT_KINDS.includes(kind),
    title: clip(scrubText(title), 120),
    body: clip(scrubText(body), 600),
    link: safeLink(link),
  };
}

/** One reminder, 15 minutes after the first alert was sent, only while the item is still waiting. */
export function reminderFor(sent: { dedupeKey: string; kind: AlertKind; title: string; body: string; link: string; sentAt: string | null; reminder: boolean }, stillWaiting: boolean, now = Date.now()): AlertDraft | null {
  if (sent.reminder || !sent.sentAt || !stillWaiting || !REMINDER_KINDS.includes(sent.kind)) return null;
  if (now - Date.parse(sent.sentAt) < REMINDER_AFTER_MS) return null;
  return { dedupeKey: clip(`${sent.dedupeKey}:reminder`, 200), kind: sent.kind, urgent: false, title: clip(`Still waiting: ${sent.title}`, 120), body: sent.body, link: sent.link, reminder: true };
}

/** Hour (0–23) in the owner's time zone. */
export function localHour(now: number, timezone: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(new Date(now));
  return Number(h) % 24;
}
/** Calendar date (YYYY-MM-DD) in the owner's time zone. */
export function localDate(now: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
}
export function validTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** Quiet hours wrap past midnight (e.g. 22 → 7). Equal or missing bounds mean no quiet hours. */
export function inQuietHours(hour: number, start: number | null, end: number | null): boolean {
  if (start === null || end === null || start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export type SendDecision = { send: true } | { send: false; hold: boolean; reason: string };
/** Whether a pending alert goes out now. "hold" keeps it pending (quiet hours); otherwise it's skipped. */
export function sendDecision(a: { kind: AlertKind; urgent: boolean }, s: AlertSettings, sentToday: number, now = Date.now()): SendDecision {
  if (a.kind === "test") return { send: true };
  if (!s.alertsEnabled && !a.urgent) return { send: false, hold: false, reason: "Alerts are turned off." };
  if (sentToday >= DAILY_ALERT_CAP && !a.urgent) return { send: false, hold: false, reason: `Daily limit of ${DAILY_ALERT_CAP} alerts reached.` };
  if (!a.urgent && inQuietHours(localHour(now, s.timezone), s.quietStart, s.quietEnd)) return { send: false, hold: true, reason: "Quiet hours." };
  return { send: true };
}

/** FCM says a token is gone (UNREGISTERED / invalid): stop using that device instead of retrying. */
export function tokenIsDead(status: number, body: string): boolean {
  return status === 404 || (status === 400 && /INVALID_ARGUMENT|registration-token-not-registered|UNREGISTERED/i.test(body));
}
export function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

import { describe, expect, it } from "vitest";
import { DAILY_ALERT_CAP, DEFAULT_ALERT_SETTINGS, draftAlert, inQuietHours, localDate, localHour, reminderFor, safeLink, scrubText, sendDecision, tokenIsDead } from "./owner-alerts";

const T = Date.parse("2026-11-07T12:00:00Z"); // 7:00 AM Eastern (EST)

describe("owner alerts", () => {
  it("uses Eastern time by default at 7 AM", () => {
    expect(DEFAULT_ALERT_SETTINGS.timezone).toBe("America/New_York");
    expect(DEFAULT_ALERT_SETTINGS.reportHour).toBe(7);
    expect(localHour(T, "America/New_York")).toBe(7);
    expect(localDate(Date.parse("2026-11-08T03:00:00Z"), "America/New_York")).toBe("2026-11-07");
  });
  it("keeps links on this site and hides secrets and emails", () => {
    expect(safeLink("https://evil.example")).toBe("/");
    expect(safeLink("//evil.example")).toBe("/");
    expect(safeLink("/settings#activation")).toBe("/settings#activation");
    const a = draftAlert("github_approval", "r1", "Run waiting", "token ghp_abcdefghijklmnop1234 for me@x.com", "/chat");
    expect(a.body).not.toContain("ghp_");
    expect(a.body).not.toContain("me@x.com");
    expect(scrubText("sk-abcdefghijklmnop")).toBe("[hidden]");
  });
  it("marks stops and spend warnings urgent; they ignore quiet hours", () => {
    const s = { ...DEFAULT_ALERT_SETTINGS, quietStart: 6, quietEnd: 9 };
    expect(draftAlert("auto_stop", "x", "t", "b", "/").urgent).toBe(true);
    expect(sendDecision({ kind: "auto_stop", urgent: true }, s, 0, T)).toEqual({ send: true });
    expect(sendDecision({ kind: "github_approval", urgent: false }, s, 0, T)).toMatchObject({ send: false, hold: true });
  });
  it("quiet hours wrap past midnight", () => {
    expect(inQuietHours(23, 22, 7)).toBe(true);
    expect(inQuietHours(3, 22, 7)).toBe(true);
    expect(inQuietHours(7, 22, 7)).toBe(false);
    expect(inQuietHours(10, null, 7)).toBe(false);
  });
  it("stops at 30 alerts a day except urgent ones", () => {
    expect(DAILY_ALERT_CAP).toBe(30);
    expect(sendDecision({ kind: "pr_ready", urgent: false }, DEFAULT_ALERT_SETTINGS, 30, T)).toMatchObject({ send: false, hold: false });
    expect(sendDecision({ kind: "spend_warning", urgent: true }, DEFAULT_ALERT_SETTINGS, 30, T)).toEqual({ send: true });
  });
  it("sends one reminder after 15 minutes, only while still waiting", () => {
    const sent = { dedupeKey: "github_approval:r1", kind: "github_approval" as const, title: "Run waiting", body: "b", link: "/chat", sentAt: new Date(T).toISOString(), reminder: false };
    expect(reminderFor(sent, true, T + 14 * 60_000)).toBeNull();
    expect(reminderFor(sent, true, T + 15 * 60_000)?.dedupeKey).toBe("github_approval:r1:reminder");
    expect(reminderFor(sent, false, T + 20 * 60_000)).toBeNull();
    expect(reminderFor({ ...sent, reminder: true }, true, T + 60 * 60_000)).toBeNull();
    expect(reminderFor({ ...sent, kind: "pr_ready" }, true, T + 60 * 60_000)).toBeNull();
  });
  it("drops dead device tokens instead of retrying", () => {
    expect(tokenIsDead(404, "")).toBe(true);
    expect(tokenIsDead(400, '{"error":{"status":"INVALID_ARGUMENT"}}')).toBe(true);
    expect(tokenIsDead(500, "")).toBe(false);
  });
});

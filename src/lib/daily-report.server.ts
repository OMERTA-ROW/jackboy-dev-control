// Daily report runtime: gathers yesterday's real records, saves one report per day and queues it as a push.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { buildDailyReport, pushText, reportDue, type DailyReport, type ReportInput } from "./daily-report";
import { CODE_ACTION } from "./code";
import { draftAlert } from "./owner-alerts";
import { enqueueAlerts, flushAlerts, getAlertSettings, waitingItems } from "./owner-alerts.server";
import { untyped } from "./untyped-db";

const db = () => untyped(supabaseAdmin);

async function activity(since: string): Promise<ReportInput["activity"]> {
  try {
    const [reqs, log, undos] = await Promise.all([
      supabaseAdmin.from("action_requests").select("status, outcome").eq("action", CODE_ACTION).gte("created_at", since),
      supabaseAdmin.from("site_log").select("action, status, pr_url, detail").gte("at", since).limit(2000),
      db().from("code_undos").select("status").gte("created_at", since),
    ]);
    if (reqs.error || log.error || undos.error) return null;
    const rows = log.data ?? [];
    const scans = rows.filter((r) => r.action === "foundry.code_scan" || r.action === "foundry.inspect_finished" || r.action === "readonly_scan");
    const findings = scans.reduce((n, r) => n + (Number((r.detail as { findings?: number } | null)?.findings) || 0), 0);
    return {
      codeRequests: (reqs.data ?? []).length,
      runsSucceeded: rows.filter((r) => /^code\.(run|task)_?(succeeded|completed|finished)/.test(r.action) && r.status === "ok").length,
      runsFailed: rows.filter((r) => /^code\./.test(r.action) && r.status === "failed").length,
      draftPrs: rows.filter((r) => r.pr_url && /draft_pr|pr_opened|transition:executing/.test(r.action)).length,
      inspections: scans.length,
      findings,
      undos: (undos.data ?? []).filter((u: { status: string }) => u.status === "done").length,
      mergedByOwner: rows.filter((r) => /merged/.test(r.action) && !/undo/.test(r.action)).length,
    };
  } catch { return null; }
}

async function spend(since: string): Promise<ReportInput["spend"]> {
  try {
    const { getCodeSafetyState } = await import("./code-safety.server");
    const s = await getCodeSafetyState();
    const calls = await db().from("code_provider_calls").select("status, actual_usd, ceiling_usd").gte("created_at", since);
    const yesterdayUsd = calls.error ? null : ((calls.data ?? []) as { status: string; actual_usd: number | null; ceiling_usd: number }[])
      .reduce((n, c) => n + (c.status === "settled" ? Number(c.actual_usd ?? 0) : c.status === "aborted" ? 0 : Number(c.ceiling_usd)), 0);
    return {
      yesterdayUsd,
      todayUsd: s.spendMeter?.measuredTodayUsd ?? null,
      dailyLimitUsd: Number.isFinite(s.dailySpendLimitUsd) ? s.dailySpendLimitUsd : null,
      totalUsd: s.totalSpendGuard?.committedUsd ?? null,
      totalLimitUsd: s.totalSpendGuard?.limitUsd ?? null,
      crossCheckProblem: Boolean(s.spendMeter && (s.spendMeter.bypassDays.length > 0 || s.spendMeter.reasons.includes("bypass_suspected"))),
    };
  } catch { return null; }
}

async function safety(since: string): Promise<ReportInput["safety"]> {
  try {
    const { getCodeSafetyState } = await import("./code-safety.server");
    const s = await getCodeSafetyState();
    const { count } = await supabaseAdmin.from("site_log").select("id", { count: "exact", head: true }).gte("at", since).in("action", ["code.auto_stop", "code.failure_stop", "code.spike_stop"]);
    return { killSwitch: s.killSwitch, codeEnabled: s.enabled, autoStops: count ?? 0 };
  } catch { return { killSwitch: null, codeEnabled: null, autoStops: 0 }; }
}

/** Builds the report for the last 24 hours (or since the previous report). Read-only. */
export async function composeReport(date: string, now = Date.now()): Promise<DailyReport> {
  const { data: last } = await db().from("daily_reports").select("generated_at").neq("report_date", date).order("report_date", { ascending: false }).limit(1).maybeSingle();
  const since = new Date(Math.max(now - 24 * 3600_000, last ? Date.parse((last as { generated_at: string }).generated_at) : 0)).toISOString();
  const [a, s, w, sf] = await Promise.all([activity(since), spend(since), waitingItems(), safety(since)]);
  const waiting = w.complete || w.drafts.length
    ? w.drafts.filter((d) => d.kind === "passkey_needed" || d.kind === "github_approval" || d.kind === "pr_ready").map((d) => ({ title: `${d.title}: ${d.body}`.slice(0, 160), link: d.link }))
    : null;
  return buildDailyReport({ date, activity: a, spend: s, waiting, safety: sf });
}

/** Saves today's report once (unique per date) and queues one push for it. Re-runs never send twice. */
export async function runDailyReport(now = Date.now(), force = false) {
  const settings = await getAlertSettings();
  const { data: last } = await db().from("daily_reports").select("report_date").order("report_date", { ascending: false }).limit(1).maybeSingle();
  const due = reportDue(now, settings.timezone, settings.reportHour, (last as { report_date: string } | null)?.report_date ?? null);
  if (!due.due && !force) return { generated: false, date: due.date, reason: "Not report time yet." };
  const report = await composeReport(due.date, now);
  const { error } = await db().from("daily_reports").upsert({ report_date: due.date, summary: report.summary, body: report as never }, { onConflict: "report_date", ignoreDuplicates: true });
  if (error) throw new Error(`The daily report could not be saved: ${error.message}`);
  const p = pushText(report);
  await enqueueAlerts([draftAlert("daily_report", due.date, p.title, p.body, "/reports")]);
  const flushed = await flushAlerts(5);
  return { generated: true, date: due.date, flushed };
}

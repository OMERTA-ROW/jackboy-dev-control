// Daily report text (pure, tested). Built only from real records; a source that can't be read
// is shown as "unavailable", never guessed. The report never starts, approves or changes anything.
import { localDate, localHour } from "./owner-alerts";

export type ReportInput = {
  date: string;
  activity: { codeRequests: number; runsSucceeded: number; runsFailed: number; draftPrs: number; inspections: number; findings: number; undos: number; mergedByOwner: number } | null;
  spend: { yesterdayUsd: number | null; todayUsd: number | null; dailyLimitUsd: number | null; totalUsd: number | null; totalLimitUsd: number | null; crossCheckProblem: boolean } | null;
  waiting: { title: string; link: string }[] | null;
  safety: { killSwitch: boolean | null; codeEnabled: boolean | null; autoStops: number } | null;
};
export type DailyReport = { date: string; summary: string; sections: { title: string; lines: string[] }[] };

const usd = (n: number | null) => (n === null || !Number.isFinite(n) ? "unavailable" : `$${n.toFixed(2)}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function buildDailyReport(i: ReportInput): DailyReport {
  const done: string[] = [];
  if (!i.activity) done.push("Activity records unavailable.");
  else {
    const a = i.activity;
    if (a.codeRequests || a.runsSucceeded || a.runsFailed) done.push(`CODE: ${plural(a.codeRequests, "request")}, ${a.runsSucceeded} finished, ${a.runsFailed} failed.`);
    if (a.draftPrs) done.push(`${plural(a.draftPrs, "draft PR")} opened.`);
    if (a.mergedByOwner) done.push(`${plural(a.mergedByOwner, "change")} merged by you.`);
    if (a.inspections) done.push(`Inspections: ${a.inspections}, ${a.findings ? plural(a.findings, "fix", "fixes") + " suggested" : "nothing new to fix"}.`);
    if (a.undos) done.push(`${plural(a.undos, "undo")}.`);
    if (!done.length) done.push("Nothing ran yesterday.");
  }
  const spent: string[] = [];
  if (!i.spend) spent.push("Spending records unavailable.");
  else {
    const s = i.spend;
    spent.push(`Yesterday ${usd(s.yesterdayUsd)}. Today so far ${usd(s.todayUsd)} of ${usd(s.dailyLimitUsd)}. Total ${usd(s.totalUsd)} of ${usd(s.totalLimitUsd)}.`);
    if (s.crossCheckProblem) spent.push("OpenAI's report does not match Jackboy's own count. Check Settings → CODE.");
  }
  const waiting: string[] = i.waiting === null ? ["Approval list unavailable."] : i.waiting.length ? i.waiting.slice(0, 8).map((w) => `${w.title} (${w.link})`) : ["Nothing is waiting for you."];
  if (i.waiting && i.waiting.length > 8) waiting.push(`…and ${i.waiting.length - 8} more.`);
  const safety: string[] = [];
  if (!i.safety) safety.push("Safety state unavailable.");
  else {
    const k = i.safety.killSwitch === null ? "unknown" : i.safety.killSwitch ? "on (work paused)" : "off";
    const c = i.safety.codeEnabled === null ? "unknown" : i.safety.codeEnabled ? "on" : "off";
    safety.push(`Kill Switch ${k}. CODE ${c}.`);
    if (i.safety.autoStops) safety.push(`${plural(i.safety.autoStops, "automatic stop")} yesterday.`);
  }
  const waitCount = i.waiting?.length ?? null;
  const headline = `Jackboy ${i.date}: ` + [
    i.activity ? `${i.activity.runsSucceeded + i.activity.inspections} done` : "activity unavailable",
    i.spend ? `${usd(i.spend.yesterdayUsd)} spent` : "spend unavailable",
    waitCount === null ? "approvals unavailable" : waitCount ? `${waitCount} waiting for you` : "nothing waiting",
  ].join(" · ");
  const sections = [
    { title: "Done", lines: done },
    { title: "Spent", lines: spent },
    { title: "Waiting for you", lines: waiting },
    { title: "Safety", lines: safety },
  ];
  const summary = [headline, ...sections.map((s) => `${s.title}: ${s.lines.join(" ")}`)].join("\n").slice(0, 4000);
  return { date: i.date, summary, sections };
}

/** Due when the owner's local hour equals the report hour and today's report doesn't exist yet. */
export function reportDue(now: number, timezone: string, reportHour: number, lastReportDate: string | null): { due: boolean; date: string } {
  const date = localDate(now, timezone);
  return { due: localHour(now, timezone) === reportHour && lastReportDate !== date, date };
}

/** Phone-sized version: the headline plus what's waiting. */
export function pushText(r: DailyReport): { title: string; body: string } {
  const [headline] = r.summary.split("\n");
  const waiting = r.sections.find((s) => s.title === "Waiting for you")?.lines.slice(0, 3).map((l) => l.replace(/ \(\/[^)]*\)$/, "")).join("; ") ?? "";
  return { title: "Jackboy morning report", body: `${headline}${waiting ? `\n${waiting}` : ""}`.slice(0, 600) };
}

import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { BellRing, Loader2, RefreshCw, Send, Smartphone, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/AppShell";
import { btn, field, primaryBtn } from "@/components/ProjectBits";
import { CodeUndoButton } from "@/components/CodeUndoButton";
import { getReportsPage, listUndoable, registerPushDevice, removePushDevice, retryAlert, saveAlertSettings, sendReportNow, sendTestAlert } from "@/lib/owner-notify.functions";
import { deviceLabel, enablePush, PUSH_STATUS_TEXT, pushWebConfigured } from "@/lib/push-client";
import type { UndoState } from "@/lib/code-undo";

export const Route = createFileRoute("/_authenticated/reports")({
  head: () => ({
    meta: [
      { title: "Reports, alerts & Undo — Jackboy" },
      { name: "description", content: "Jackboy's morning report, phone alerts for waiting approvals, and one-press Undo for CODE changes." },
      { property: "og:title", content: "Reports, alerts & Undo — Jackboy" },
      { property: "og:description", content: "Daily summary, push alerts and safe rollback for CODE." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ReportsPage,
});

type Page = Awaited<ReturnType<typeof getReportsPage>>;
const hours = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => new Date(2026, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });
const STATUS_CLASS: Record<string, string> = { sent: "text-success", failed: "text-destructive", pending: "text-muted-foreground", skipped: "text-muted-foreground" };

function ReportsPage() {
  const load = useServerFn(getReportsPage), loadUndo = useServerFn(listUndoable);
  const [page, setPage] = useState<Page | null>(null), [undos, setUndos] = useState<UndoState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setPage(await load()); setError(null); } catch (e) { setError(e instanceof Error ? e.message : "Couldn't load reports."); }
    try { setUndos(await loadUndo()); } catch { setUndos([]); }
  }, [load, loadUndo]);
  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <>
      <PageHeader title="Reports, alerts & Undo" subtitle="A morning summary, a nudge on your phone when something waits for you, and a safe way to take back a CODE change." />
      {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
      {!page ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</p> : (
        <div className="space-y-6">
          <ReportSection page={page} onChange={refresh} />
          <AlertsSection page={page} onChange={refresh} />
          <UndoSection undos={undos} />
        </div>
      )}
    </>
  );
}

function ReportSection({ page, onChange }: { page: Page; onChange: () => Promise<void> }) {
  const sendNow = useServerFn(sendReportNow);
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState<string | null>(null);
  return (
    <section aria-labelledby="report-h" className="panel p-5">
      <h2 id="report-h" className="text-sm font-semibold uppercase tracking-wider text-silver">Morning report</h2>
      <p className="mt-1 text-xs text-muted-foreground">Sent every day at {hourLabel(page.settings.reportHour)} ({page.settings.timezone.replace("_", " ")}). Built only from real records; anything unreadable says “unavailable”.</p>
      <h3 className="mt-4 text-xs font-semibold">Today so far</h3>
      {page.preview ? <pre className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-xs">{page.preview.summary}</pre> : <p className="mt-1 text-xs text-destructive">{page.previewError}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className={btn} disabled={busy} onClick={async () => {
          setBusy(true); setMsg(null);
          try { const r = await sendNow(); setMsg(r.generated ? `Today's report saved${"flushed" in r && r.flushed && r.flushed.sent ? " and sent to your phone" : ""}. If it was already sent today, it isn't sent twice.` : r.reason); await onChange(); }
          catch (e) { setMsg(e instanceof Error ? e.message : "Couldn't send the report."); } finally { setBusy(false); }
        }}><Send className="mr-1 h-3 w-3" aria-hidden />{busy ? "Sending…" : "Send today's report now"}</button>
        {msg && <span role="status" className="text-xs text-muted-foreground">{msg}</span>}
      </div>
      <h3 className="mt-5 text-xs font-semibold">Past reports</h3>
      {page.reports.length ? (
        <ul className="mt-2 space-y-2">
          {page.reports.map((r) => (
            <li key={r.report_date}>
              <details className="rounded-md border border-border p-3">
                <summary className="cursor-pointer text-sm">{r.report_date} · <span className="text-muted-foreground">{r.summary.split("\n")[0]}</span></summary>
                <pre className="mt-2 whitespace-pre-wrap font-mono text-xs">{r.summary}</pre>
              </details>
            </li>
          ))}
        </ul>
      ) : <p className="mt-1 text-xs text-muted-foreground">No reports yet. The first one arrives at the next report time.</p>}
    </section>
  );
}

function AlertsSection({ page, onChange }: { page: Page; onChange: () => Promise<void> }) {
  const register = useServerFn(registerPushDevice), remove = useServerFn(removePushDevice), test = useServerFn(sendTestAlert), retry = useServerFn(retryAlert), save = useServerFn(saveAlertSettings);
  const [busy, setBusy] = useState<string | null>(null), [msg, setMsg] = useState<string | null>(null);
  const [s, setS] = useState(page.settings);
  useEffect(() => setS(page.settings), [page.settings]);
  const act = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key); setMsg(null);
    try { const m = await fn(); if (m) setMsg(m); await onChange(); }
    catch (e) { setMsg(e instanceof Error ? e.message : "Something went wrong."); } finally { setBusy(null); }
  };
  const ready = page.pushConfigured && pushWebConfigured();
  return (
    <section aria-labelledby="alerts-h" className="panel p-5">
      <h2 id="alerts-h" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-silver"><BellRing className="h-4 w-4" aria-hidden /> Phone alerts</h2>
      <p className="mt-1 text-xs text-muted-foreground">A push notification when a CODE run or task needs your passkey or GitHub approval, a draft PR is ready, or CODE stops itself. One reminder after 15 minutes, at most 30 a day. A tap only opens the page; approving still happens there with your passkey or in GitHub.</p>
      <p role="status" className={`mt-3 text-sm ${ready ? "text-success" : "text-destructive"}`}>
        {ready ? "Push is connected." : page.pushConfigured ? "Push is connected on the server, but this site's web push settings are missing. Update the Firebase connection with “Include web push”." : "Push isn't connected yet: the Firebase connection still needs to be set up. Alerts are kept here and marked “not delivered” until then."}
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={primaryBtn} disabled={!!busy} onClick={() => act("enable", async () => {
          const r = await enablePush();
          if (r.status !== "registered") return PUSH_STATUS_TEXT[r.status];
          await register({ data: { token: r.token, label: deviceLabel() } });
          return "This device will now get Jackboy alerts. Press “Send test alert” to check.";
        })}><Smartphone className="h-4 w-4" aria-hidden />{busy === "enable" ? "Asking this device…" : "Get alerts on this device"}</button>
        <button type="button" className={btn} disabled={!!busy} onClick={() => act("test", async () => {
          const r = await test();
          return r.delivered ? "Test alert sent. It should appear on your phone within a few seconds." : `Test alert not delivered: ${r.error ?? "no device accepted it."}`;
        })}><Send className="mr-1 h-3 w-3" aria-hidden />{busy === "test" ? "Sending…" : "Send test alert"}</button>
      </div>
      {msg && <p role="status" className="mt-2 text-xs">{msg}</p>}

      <h3 className="mt-5 text-xs font-semibold">Your devices</h3>
      {page.devices.length ? (
        <ul className="mt-2 space-y-1 text-sm">
          {page.devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2">
              <span>{d.label}</span>
              <span className={`text-xs ${d.active ? "text-success" : "text-destructive"}`}>{d.active ? "active" : "stopped"}</span>
              {d.last_sent_at && <span className="text-xs text-muted-foreground">last alert {new Date(d.last_sent_at).toLocaleString()}</span>}
              {d.last_error && <span className="text-xs text-destructive">{d.last_error}</span>}
              <button type="button" className="text-xs underline" disabled={!!busy} onClick={() => act(`rm-${d.id}`, async () => { await remove({ data: { id: d.id } }); return "Device removed."; })}><Trash2 className="mr-1 inline h-3 w-3" aria-hidden />Remove</button>
            </li>
          ))}
        </ul>
      ) : <p className="mt-1 text-xs text-muted-foreground">No devices yet. On your phone, open Jackboy and press “Get alerts on this device”.</p>}

      <h3 className="mt-5 text-xs font-semibold">Timing</h3>
      <form className="mt-2 grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void act("save", async () => { await save({ data: s }); return "Saved."; }); }}>
        <label className="text-xs">Time zone
          <input className={field} value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} />
        </label>
        <label className="text-xs">Morning report at
          <select className={field} value={s.reportHour} onChange={(e) => setS({ ...s, reportHour: Number(e.target.value) })}>{hours.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</select>
        </label>
        <label className="text-xs">Quiet hours start
          <select className={field} value={s.quietStart ?? ""} onChange={(e) => setS({ ...s, quietStart: e.target.value === "" ? null : Number(e.target.value) })}><option value="">No quiet hours</option>{hours.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</select>
        </label>
        <label className="text-xs">Quiet hours end
          <select className={field} value={s.quietEnd ?? ""} onChange={(e) => setS({ ...s, quietEnd: e.target.value === "" ? null : Number(e.target.value) })}><option value="">—</option>{hours.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</select>
        </label>
        <label className="flex items-center gap-2 text-xs sm:col-span-2">
          <input type="checkbox" checked={s.alertsEnabled} onChange={(e) => setS({ ...s, alertsEnabled: e.target.checked })} />
          Send alerts (stops and spending warnings always come through)
        </label>
        <div className="sm:col-span-2"><button type="submit" className={btn} disabled={!!busy}>{busy === "save" ? "Saving…" : "Save timing"}</button></div>
      </form>

      <h3 className="mt-5 text-xs font-semibold">Recent alerts</h3>
      {page.alerts.length ? (
        <ul className="mt-2 space-y-1 text-xs">
          {page.alerts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline gap-2">
              <span className="text-muted-foreground">{new Date(a.created_at).toLocaleString()}</span>
              <span className="font-medium">{a.title}</span>
              <span className={STATUS_CLASS[a.status] ?? ""}>{a.status === "failed" ? "not delivered" : a.status}</span>
              {a.last_error && <span className="text-muted-foreground">({a.last_error})</span>}
              {(a.status === "failed" || a.status === "skipped") && <button type="button" className="underline" disabled={!!busy} onClick={() => act(`retry-${a.id}`, async () => { await retry({ data: { id: a.id } }); return "Retried."; })}><RefreshCw className="mr-1 inline h-3 w-3" aria-hidden />Retry</button>}
            </li>
          ))}
        </ul>
      ) : <p className="mt-1 text-xs text-muted-foreground">No alerts yet.</p>}
    </section>
  );
}

function UndoSection({ undos }: { undos: UndoState[] | null }) {
  return (
    <section aria-labelledby="undo-h" className="panel p-5">
      <h2 id="undo-h" className="text-sm font-semibold uppercase tracking-wider text-silver">Undo CODE changes</h2>
      <p className="mt-1 text-xs text-muted-foreground">A draft PR closes right away (its branch is kept). A merged change needs your passkey: Jackboy restores every touched file exactly, opens a revert, and merges it only after its checks pass. If newer work changed the same files, Undo refuses rather than overwrite it. Undo is blocked while the Kill Switch is on, and costs nothing.</p>
      {undos === null ? <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Checking recent CODE changes…</p>
        : undos.length ? (
          <ul className="mt-3 space-y-3">
            {undos.map((u) => (
              <li key={u.requestId} className="rounded-md border border-border p-3 text-sm">
                <p>{u.repo} · {u.prUrl ? <a href={u.prUrl} target="_blank" rel="noopener noreferrer" className="text-electric underline">PR #{u.prNumber}</a> : "no PR"} <span className="text-xs text-muted-foreground">({u.kind === "revert_merged" ? "merged" : u.kind === "close_draft" ? "draft, not merged" : "closed"})</span></p>
                <div className="mt-1"><CodeUndoButton requestId={u.requestId} initial={u} /></div>
              </li>
            ))}
          </ul>
        ) : <p className="mt-3 text-xs text-muted-foreground">No CODE changes with a pull request yet.</p>}
    </section>
  );
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { PageHeader } from "@/components/AppShell";
import { getSiteLog } from "@/lib/site-log.functions";
import { useJackboy, type LogLevel } from "@/lib/jackboy-store";

export const Route = createFileRoute("/_authenticated/activity")({
  head: () => ({
    meta: [
      { title: "Logs & Approvals — Jackboy" },
      { name: "description", content: "Recent real Jackboy actions from the permanent Site Log, plus where approvals wait." },
      { property: "og:title", content: "Logs & Approvals — Jackboy" },
      { property: "og:description", content: "Recent Site Log entries and approval links." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ActivityPage,
});

const STATUS: Record<string, string> = {
  ok: "text-success",
  failed: "text-destructive",
  blocked: "text-warning",
  pending: "text-electric",
  rolled_back: "text-warning",
  info: "text-silver-dim",
};
const LOCAL: Record<LogLevel, string> = { info: "text-silver-dim", success: "text-success", error: "text-destructive", approval: "text-electric" };
const FILTERS = ["all", "ok", "failed", "blocked", "pending"] as const;

function ActivityPage() {
  const load = useServerFn(getSiteLog);
  const local = useJackboy();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [rows, setRows] = useState<Record<string, string | null>[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const r = await load({ data: { limit: 100, status: filter === "all" ? undefined : filter } });
      setRows(r.rows);
      setError(null);
      setCheckedAt(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [load, filter]);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  return (
    <>
      <PageHeader title="Logs & Approvals" subtitle="The newest real entries from the permanent Site Log, and where your approvals wait." />
      <section className="panel mb-6 p-4 text-sm" aria-labelledby="ap">
        <h2 id="ap" className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Waiting for you</h2>
        <div className="flex flex-wrap gap-4">
          <Link to="/updates" className="text-electric underline">Update Queue (fixes to approve)</Link>
          <Link to="/blockers" className="text-electric underline">Blockers</Link>
          <Link to="/settings" className="text-electric underline">Autonomous Activation</Link>
        </div>
      </section>
      <section className="panel p-4" aria-labelledby="lg">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="lg" className="text-sm font-semibold uppercase tracking-wider text-silver">Site Log (newest 100)</h2>
          <div className="flex flex-wrap items-center gap-1">
            {FILTERS.map((f) => (
              <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}
                className={`rounded px-2 py-1 text-xs capitalize ${filter === f ? "bg-secondary text-silver" : "text-muted-foreground"}`}>{f}</button>
            ))}
            <button disabled={busy} onClick={() => void refresh()} className="ml-2 rounded border border-border px-2 py-1 text-xs disabled:opacity-50">{busy ? "Checking…" : "Refresh"}</button>
            <Link to="/site-log" className="ml-1 text-xs text-electric underline">Full Site Log →</Link>
          </div>
        </div>
        {checkedAt && !error && <p className="mb-2 text-xs text-muted-foreground" role="status">Checked at {checkedAt.toLocaleTimeString()}</p>}
        {error && <p role="alert" className="mb-2 text-sm text-destructive">Couldn't load the Site Log: {error}</p>}
        {rows === null ? <p className="text-sm text-muted-foreground">Loading…</p> : rows.length === 0 ? <p className="text-sm text-muted-foreground">No entries.</p> : (
          <ol className="divide-y divide-border font-mono text-xs">
            {rows.map((l) => (
              <li key={l.id} className="flex flex-wrap gap-x-3 py-2">
                <time className="w-36 shrink-0 text-muted-foreground">{l.at ? new Date(l.at).toLocaleString() : ""}</time>
                <span className={`w-16 shrink-0 uppercase ${STATUS[l.status ?? "info"] ?? ""}`}>{l.status}</span>
                <span className="min-w-0 flex-1 break-words text-foreground">{l.summary}</span>
              </li>
            ))}
          </ol>)}
      </section>
      {local.logs.length > 0 && (
        <details className="panel mt-6 p-4 text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground">Older local notes from this browser ({local.logs.length}) — not part of the Site Log</summary>
          <ol className="mt-2 divide-y divide-border font-mono text-xs">
            {local.logs.map((l) => (
              <li key={l.id} className="flex gap-3 py-2">
                <time className="w-36 shrink-0 text-muted-foreground">{new Date(l.at).toLocaleString()}</time>
                <span className={`w-16 shrink-0 uppercase ${LOCAL[l.level]}`}>{l.level}</span>
                <span className="min-w-0 break-words">{l.message}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}

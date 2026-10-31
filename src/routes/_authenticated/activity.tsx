import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { resolveSuggestion, setState, useJackboy, type LogLevel } from "@/lib/jackboy-store";

export const Route = createFileRoute("/activity")({
  head: () => ({
    meta: [
      { title: "Logs & Approvals — Jackboy" },
      { name: "description", content: "Every Jackboy action and approval, recorded locally." },
      { property: "og:title", content: "Logs & Approvals — Jackboy" },
      { property: "og:description", content: "Audit log and approval queue." },
    ],
  }),
  component: ActivityPage,
});

const COLOR: Record<LogLevel, string> = {
  info: "text-silver-dim",
  success: "text-success",
  error: "text-destructive",
  approval: "text-electric",
};

function ActivityPage() {
  const s = useJackboy();
  const [filter, setFilter] = useState<LogLevel | "all">("all");
  const logs = s.logs.filter((l) => filter === "all" || l.level === filter);
  const pending = s.suggestions.filter((x) => x.status === "pending");

  return (
    <>
      <PageHeader title="Logs & Approvals" subtitle="A local audit trail of everything Jackboy did, and anything waiting for your decision." />
      <section className="panel mb-6 p-4" aria-labelledby="ap">
        <h2 id="ap" className="mb-3 text-sm font-semibold uppercase tracking-wider text-silver">Pending approvals ({pending.length})</h2>
        {pending.length === 0 ? <p className="text-sm text-muted-foreground">Nothing waiting. Jackboy never changes your layout or code without approval.</p> : (
          <ul className="space-y-2">{pending.map((p) => (
            <li key={p.id} className="flex flex-col gap-2 rounded-md bg-muted p-3 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-sm">{p.title}</span>
              <span className="flex gap-2">
                <button className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground" onClick={() => resolveSuggestion(p.id, true)}>Approve</button>
                <button className="rounded-md border border-border px-3 py-1.5 text-xs" onClick={() => resolveSuggestion(p.id, false)}>Dismiss</button>
              </span>
            </li>))}
          </ul>)}
      </section>
      <section className="panel p-4" aria-labelledby="lg">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="lg" className="text-sm font-semibold uppercase tracking-wider text-silver">Activity log</h2>
          <div className="flex flex-wrap gap-1">
            {(["all", "info", "success", "error", "approval"] as const).map((f) => (
              <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}
                className={`rounded px-2 py-1 text-xs capitalize ${filter === f ? "bg-secondary text-silver" : "text-muted-foreground"}`}>{f}</button>
            ))}
            <button onClick={() => setState((x) => ({ ...x, logs: [] }))} className="ml-2 rounded border border-destructive/40 px-2 py-1 text-xs text-destructive">Clear</button>
          </div>
        </div>
        {logs.length === 0 ? <p className="text-sm text-muted-foreground">No entries.</p> : (
          <ol className="divide-y divide-border font-mono text-xs">
            {logs.map((l) => (
              <li key={l.id} className="flex gap-3 py-2">
                <time className="w-36 shrink-0 text-muted-foreground">{new Date(l.at).toLocaleString()}</time>
                <span className={`w-16 shrink-0 uppercase ${COLOR[l.level]}`}>{l.level}</span>
                <span className="min-w-0 break-words text-foreground">{l.message}</span>
              </li>
            ))}
          </ol>)}
      </section>
    </>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, XCircle, AlertTriangle, Activity, ArrowUpRight } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { GuidanceTip, PageHeader } from "@/components/AppShell";
import { log, resolveSuggestion, setState, trackUse, useJackboy } from "@/lib/jackboy-store";

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({
    meta: [
      { title: "Dashboard — Jackboy" },
      { name: "description", content: "Your familiar Jackboy dev & ops dashboard with optional assist mode." },
      { property: "og:title", content: "Dashboard — Jackboy" },
      { property: "og:description", content: "Hybrid dev & ops dashboard: Classic View or Jackboy Assist." },
    ],
  }),
  component: Dashboard,
});

const DEMO = {
  builds: [
    { name: "web-app · main", status: "ok", time: "2m ago" },
    { name: "api · release/1.4", status: "fail", time: "18m ago" },
    { name: "docs · main", status: "ok", time: "1h ago" },
  ],
  services: [
    { name: "Auth service", status: "ok", latency: "84ms" },
    { name: "Queue worker", status: "warn", latency: "412ms" },
    { name: "Edge cache", status: "ok", latency: "12ms" },
  ],
};

function StatusIcon({ s }: { s: string }) {
  if (s === "ok") return <CheckCircle2 className="h-4 w-4 text-success" aria-label="Healthy" />;
  if (s === "fail") return <XCircle className="h-4 w-4 text-destructive" aria-label="Failed" />;
  return <AlertTriangle className="h-4 w-4 text-warning" aria-label="Degraded" />;
}

function Panel({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`p-${id}`} className="panel p-4" onClick={() => trackUse(id)}>
      <div className="mb-3 flex items-center justify-between">
        <h2 id={`p-${id}`} className="text-sm font-semibold uppercase tracking-wider text-silver">{title}</h2>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">demo</span>
      </div>
      {children}
    </section>
  );
}

function Dashboard() {
  const s = useJackboy();
  const pending = s.suggestions.filter((x) => x.status === "pending");

  const panels: Record<string, React.ReactNode> = {
    status: (
      <Panel id="status" title="System status">
        <div className="grid grid-cols-3 gap-3 text-center">
          {[["Healthy", 4, "text-success"], ["Degraded", 1, "text-warning"], ["Failing", 1, "text-destructive"]].map(([l, n, c]) => (
            <div key={l as string} className="rounded-md bg-muted p-3">
              <div className={`font-display text-2xl font-bold ${c}`}>{n}</div>
              <div className="text-xs text-muted-foreground">{l}</div>
            </div>
          ))}
        </div>
      </Panel>
    ),
    builds: (
      <Panel id="builds" title="Recent builds">
        <ul className="space-y-2">
          {DEMO.builds.map((b) => (
            <li key={b.name} className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
              <span className="flex items-center gap-2 font-mono text-xs"><StatusIcon s={b.status} />{b.name}</span>
              <span className="text-xs text-muted-foreground">{b.time}</span>
            </li>
          ))}
        </ul>
      </Panel>
    ),
    services: (
      <Panel id="services" title="Services">
        <ul className="space-y-2">
          {DEMO.services.map((b) => (
            <li key={b.name} className="flex items-center justify-between rounded-md bg-muted px-3 py-2 text-sm">
              <span className="flex items-center gap-2"><StatusIcon s={b.status} />{b.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{b.latency}</span>
            </li>
          ))}
        </ul>
      </Panel>
    ),
    activity: (
      <Panel id="activity" title="Latest activity">
        <ul className="space-y-1.5 text-sm">
          {s.logs.slice(0, 4).map((l) => (
            <li key={l.id} className="flex gap-2 text-muted-foreground"><Activity className="mt-0.5 h-3.5 w-3.5 shrink-0" />{l.message}</li>
          ))}
        </ul>
      </Panel>
    ),
  };

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Your layout stays put. Jackboy Assist only adds optional guidance and suggestions you approve." />

      {s.mode === "assist" && (
        <section aria-label="Assist controls" className="panel glow-electric mb-6 grid gap-4 p-4 md:grid-cols-2">
          <label className="flex items-start justify-between gap-4">
            <span><span className="block text-sm font-medium">Contextual guidance</span><span className="text-xs text-muted-foreground">Show tips on each page.</span></span>
            <Switch checked={s.guidance} onCheckedChange={(v) => { setState((x) => ({ ...x, guidance: v })); log("info", `Guidance ${v ? "enabled" : "disabled"}.`); }} />
          </label>
          <label className="flex items-start justify-between gap-4">
            <span><span className="block text-sm font-medium">Learn from my usage</span><span className="text-xs text-muted-foreground">Stored only in this browser. Used to propose layout changes.</span></span>
            <Switch checked={s.learnUsage} onCheckedChange={(v) => { setState((x) => ({ ...x, learnUsage: v, usage: v ? x.usage : {} })); log("info", `Usage learning ${v ? "enabled" : "disabled and cleared"}.`); }} />
          </label>
          {pending.map((p) => (
            <div key={p.id} className="flex flex-col gap-2 rounded-md border border-electric/40 bg-accent/30 p-3 md:col-span-2 md:flex-row md:items-center md:justify-between">
              <div><div className="flex items-center gap-1 text-sm font-medium"><ArrowUpRight className="h-4 w-4 text-electric" />{p.title}</div><div className="text-xs text-muted-foreground">{p.detail}</div></div>
              <div className="flex gap-2">
                <button className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground" onClick={() => resolveSuggestion(p.id, true)}>Approve</button>
                <button className="rounded-md border border-border px-3 py-1.5 text-xs" onClick={() => resolveSuggestion(p.id, false)}>Dismiss</button>
              </div>
            </div>
          ))}
        </section>
      )}

      <GuidanceTip>Click any panel to register use (if learning is on). After 3 uses Jackboy proposes moving it up — you decide.</GuidanceTip>

      <div className="grid gap-4 lg:grid-cols-2">
        {s.pinned.map((id) => <div key={id}>{panels[id]}</div>)}
      </div>
    </>
  );
}

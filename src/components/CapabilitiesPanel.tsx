import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getTesterCapabilities } from "@/lib/capabilities.functions";
import type { TesterStatus } from "@/lib/capabilities";

const LABEL: Record<TesterStatus, string> = { working: "Working", needs_testing: "Needs testing", not_connected: "Not connected" };
const TONE: Record<TesterStatus, string> = { working: "text-success", needs_testing: "text-primary", not_connected: "text-muted-foreground" };

/** Shows controls without running anything: a visible, disabled badge when a capability isn't active. */
export function PreviewGate({ active, children }: { active: boolean; children: React.ReactNode }) {
  if (active) return <>{children}</>;
  return <span aria-disabled="true" className="inline-flex cursor-not-allowed items-center gap-2 opacity-60" title="Preview — not active">{children}<span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider">Preview · not active</span></span>;
}

export function CapabilitiesPanel() {
  const fn = useServerFn(getTesterCapabilities);
  const q = useQuery({ queryKey: ["tester-capabilities"], queryFn: () => fn() });
  return <section aria-labelledby="capabilities" className="mb-6 rounded-lg border border-border bg-card p-4">
    <h2 id="capabilities" className="text-sm font-semibold uppercase tracking-wider text-silver">What Jackboy can do</h2>
    <p className="mt-1 text-xs text-muted-foreground">Live status from real checks. Nothing here runs automatically.</p>
    {q.isLoading && <p className="mt-3 text-sm text-muted-foreground">Checking…</p>}
    {q.error && <p role="alert" className="mt-3 text-sm text-destructive">{(q.error as Error).message}</p>}
    {q.data && <>
      <p className="mt-3 text-sm">Emergency pause: <strong className={q.data.safety.emergencyPause ? "text-destructive" : "text-success"}>{q.data.safety.emergencyPause ? "On — all actions stopped" : "Off"}</strong> · Schedules: {q.data.safety.schedules ? "On" : "Off"} · Autopilot: {q.data.safety.autopilot ? "On" : "Off"}</p>
      <ul className="mt-3 divide-y divide-border">{q.data.capabilities.map((c) => <li key={c.id} className="py-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2"><PreviewGate active={c.actionsActive}><span className="font-medium">{c.label}</span></PreviewGate><span className={`text-xs font-semibold ${TONE[c.status]}`}>{LABEL[c.status]}</span></div>
        <p className="text-xs text-muted-foreground">{c.detail}{c.fix ? ` · Next: ${c.fix}` : ""}</p>
      </li>)}</ul>
    </>}
  </section>;
}

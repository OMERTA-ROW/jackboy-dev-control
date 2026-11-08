import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getAutonomyStatus } from "@/lib/autonomy-status.functions";
import type { RowState, StatusRow } from "@/lib/autonomy-status";

const LABEL: Record<RowState, string> = { running: "Running", on: "On", off: "Off", not_running: "Not running", blocked: "Blocked", unverified: "Unverified" };
const TONE: Record<RowState, string> = {
  running: "text-success", on: "text-primary", off: "text-muted-foreground", not_running: "text-destructive", blocked: "text-destructive", unverified: "text-muted-foreground",
};

function Rows({ rows }: { rows: StatusRow[] }) {
  return <ul className="mt-2 divide-y divide-border">{rows.map((r) => <li key={r.id} className="py-2 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{r.label}</span><span className={`text-xs font-semibold uppercase tracking-wider ${TONE[r.state]}`}>{LABEL[r.state]}</span></div>
    <p className="text-xs text-muted-foreground">{r.detail}{r.fix ? <> · <span className="text-foreground">Next: {r.fix}</span></> : null}</p>
  </li>)}</ul>;
}

/** Read-only: what is switched on vs what actually runs. Switches alone are never shown as proof. */
export function AutonomyStatusPanel() {
  const fn = useServerFn(getAutonomyStatus);
  const q = useQuery({ queryKey: ["autonomy-status"], queryFn: () => fn(), refetchInterval: 60_000, refetchOnWindowFocus: true });
  return <section aria-labelledby="autonomy-status" className="mb-6 rounded-lg border border-border bg-card p-4">
    <h2 id="autonomy-status" className="text-sm font-semibold uppercase tracking-wider text-silver">What's really running</h2>
    <p className="mt-1 text-xs text-muted-foreground">Switches you set, compared with real run records. Read-only; nothing here turns anything on or off.</p>
    {q.isLoading && <p className="mt-3 text-sm text-muted-foreground">Reading live state…</p>}
    {q.error && <p role="alert" className="mt-3 text-sm text-destructive">{(q.error as Error).message}</p>}
    {q.data && <div className="mt-3 grid gap-4 lg:grid-cols-2">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-silver">Jackboy (Lovable side)</h3>
        <p role="status" data-testid="lovable-headline" className="mt-1 rounded border border-border px-3 py-2 text-sm">{q.data.headline.lovable}</p>
        <Rows rows={q.data.lovable} />
        <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-silver">Background jobs (run records)</h3>
        <Rows rows={q.data.schedules} />
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-silver">GitHub CODE execution (separate system)</h3>
        <p role="status" data-testid="code-headline" className="mt-1 rounded border border-border px-3 py-2 text-sm">{q.data.headline.code}</p>
        <Rows rows={q.data.code} />
        <Rows rows={[q.data.omni]} />
        <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-silver">Always yours — no switch grants these</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">{q.data.ownerOnly.map((o) => <li key={o}>{o}</li>)}</ul>
      </div>
      <p className="text-[11px] text-muted-foreground lg:col-span-2">Read at {new Date(q.data.observedAt).toLocaleTimeString()} · refreshes every minute.</p>
    </div>}
  </section>;
}

import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { ArrowUpRight, Activity, ShieldAlert } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { GuidanceTip, PageHeader } from "@/components/AppShell";
import { log, resolveSuggestion, setState, useJackboy } from "@/lib/jackboy-store";
import { getDashboardFacts } from "@/lib/passport.functions";

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({
    meta: [
      { title: "Dashboard — Jackboy" },
      { name: "description", content: "Owner project and task status from authenticated Jackboy records." },
    ],
  }),
  component: Dashboard,
});

type Facts = Awaited<ReturnType<typeof getDashboardFacts>>;
const card = "panel p-5";
const label = "text-xs font-semibold uppercase tracking-wider text-muted-foreground";

function Dashboard() {
  const state = useJackboy();
  const load = useServerFn(getDashboardFacts);
  const [facts, setFacts] = useState<Facts | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void load()
      .then(setFacts)
      .catch((e) => setError((e as Error).message));
  }, []);
  const pending = state.suggestions.filter((x) => x.status === "pending");
  const queued = facts ? facts.jobs.filter((j) => j.status === "queued" && !j.sent_at).length : undefined;
  const openReports = facts
    ? facts.reports.filter((r) => r.status === "open" || r.status === "acknowledged").length
    : undefined;
  const pendingProposals = facts
    ? facts.proposals.filter((p) => p.status === "proposed" || p.status === "pending").length
    : undefined;

  return (
    <>
      <PageHeader
        title="Jackboy"
        subtitle="Your registered projects, real task records, and next steps in one place."
      />
      {error && (
        <p role="alert" className="mb-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {state.mode === "assist" && (
        <section aria-label="Assist controls" className={card + " mb-5"}>
          <h2 className="text-sm font-semibold">Jackboy Assist</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Optional guidance and layout suggestions are stored in this browser.
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="flex items-center justify-between gap-3 text-sm">
              Contextual guidance{" "}
              <Switch
                checked={state.guidance}
                onCheckedChange={(v) => {
                  setState((s) => ({ ...s, guidance: v }));
                  log("info", `Guidance ${v ? "enabled" : "disabled"}.`);
                }}
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              Learn from my usage{" "}
              <Switch
                checked={state.learnUsage}
                onCheckedChange={(v) => {
                  setState((s) => ({ ...s, learnUsage: v, usage: v ? s.usage : {} }));
                  log("info", `Usage learning ${v ? "enabled" : "disabled and cleared"}.`);
                }}
              />
            </label>
          </div>
          {pending.map((p) => (
            <div
              key={p.id}
              className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
            >
              <div>
                <span className="font-medium">{p.title}</span>
                <p className="text-xs text-muted-foreground">{p.detail}</p>
              </div>
              <div className="flex gap-2">
                <button
                  className="rounded-md bg-primary px-3 py-1.5 text-xs"
                  onClick={() => resolveSuggestion(p.id, true)}
                >
                  Approve
                </button>
                <button
                  className="rounded-md border border-border px-3 py-1.5 text-xs"
                  onClick={() => resolveSuggestion(p.id, false)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Live Jackboy counts">
        <Metric name="Registered projects" value={facts?.projects.length} to="/agents" />
        <Metric name="Queued OMNI tasks" value={queued} to="/omni" />
        <Metric name="Open reports" value={openReports} to="/agents" />
        <Metric name="Pending proposals" value={pendingProposals} to="/agents" />
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <section className={card}>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Projects</h2>
            <Link to="/agents" className="text-xs text-electric">
              Manage projects <ArrowUpRight className="inline h-3 w-3" />
            </Link>
          </div>
          {!facts ? (
            <p className="mt-3 text-sm text-muted-foreground">Loading private records…</p>
          ) : facts.projects.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No project registered. Add the first one in Agent Hub.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {facts.projects.slice(0, 5).map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 rounded-md bg-muted p-3 text-sm">
                  <span>{p.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {p.enrolled ? `Enrolled · ${p.health}` : "Registered · not enrolled"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className={card}>
          <h2 className="font-semibold">Connection status</h2>
          <div className="mt-3 flex items-start gap-2 text-sm">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div>
              <strong>OMNI worker not connected</strong>
              <p className="text-xs text-muted-foreground">
                Tasks are stored here and stay unsent until an authenticated dispatcher is built and tested.
              </p>
            </div>
          </div>
          <div className="mt-3 flex items-start gap-2 text-sm">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <div>
              <strong>Lovable inventory not synced</strong>
              <p className="text-xs text-muted-foreground">
                Only projects you register appear here. Automatic intake needs an authorized connection.
              </p>
            </div>
          </div>
          <Link to="/integrations" className="mt-4 inline-block text-xs text-electric">
            See integration requirements →
          </Link>
        </section>
        <section className={card}>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Recent OMNI tasks</h2>
            <Link to="/omni" className="text-xs text-electric">
              Open task board →
            </Link>
          </div>
          {!facts || facts.jobs.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No tasks recorded.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {facts.jobs.slice(0, 5).map((j) => (
                <li key={j.id} className="flex justify-between gap-2 rounded-md bg-muted p-3 text-sm">
                  <span>
                    {facts.projects.find((p) => p.id === j.project_id)?.name ?? "Project"} · {j.kind}
                  </span>
                  <span className="text-xs text-warning">{j.sent_at ? j.status : "Queued, unsent"}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className={card}>
          <h2 className="flex items-center gap-2 font-semibold">
            <Activity className="h-4 w-4" /> Recent recorded activity
          </h2>
          {!facts || facts.events.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No audit events recorded.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {facts.events.slice(0, 5).map((e) => (
                <li key={e.id} className="flex justify-between gap-2 text-xs">
                  <span>{e.action}</span>
                  <time className="text-muted-foreground" dateTime={e.at}>
                    {new Date(e.at).toLocaleString()}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <GuidanceTip>
        Jackboy shows recorded work and connection status. A queued task is not proof that an agent ran it.
      </GuidanceTip>
    </>
  );
}
function Metric({ name, value, to }: { name: string; value?: number; to: "/agents" | "/omni" }) {
  return (
    <Link to={to} className={card + " block hover:border-electric"}>
      <div className={label}>{name}</div>
      <div className="mt-2 font-display text-3xl font-bold text-silver">{value ?? "—"}</div>
    </Link>
  );
}

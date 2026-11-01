import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/AppShell";
import { actOnBlocker, getBlockers } from "@/lib/blockers.functions";
import { approvalTarget, type Blocker } from "@/lib/blockers";
import { useStepUp } from "@/lib/step-up-client";

export const Route = createFileRoute("/_authenticated/blockers")({
  head: () => ({
    meta: [
      { title: "Blocker Queue — Jackboy" },
      { name: "description", content: "What is stopping each connected project, the exact missing permission or integration, and the fix." },
      { property: "og:title", content: "Blocker Queue — Jackboy" },
      { property: "og:description", content: "Real blockers per connected project with scoped approvals and verified fixes." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Blockers,
});

const STATUS: Record<Blocker["status"], [string, string]> = {
  needs_approval: ["Needs your approval", "text-warning"],
  owner_action: ["Needs you on the provider", "text-warning"],
  auto_checking: ["Jackboy re-checking", "text-electric"],
  paused: ["Paused", "text-muted-foreground"],
  unsupported: ["No supported connection", "text-destructive"],
};
const btn = "rounded-md border border-border px-3 py-1.5 text-xs hover:border-electric disabled:opacity-50";
type Data = Awaited<ReturnType<typeof getBlockers>>;

function Blockers() {
  const load = useServerFn(getBlockers), act = useServerFn(actOnBlocker), stepUp = useStepUp();
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(() => load().then(setD).catch((e) => setErr((e as Error).message)), [load]);
  useEffect(() => { void refresh(); }, [refresh]);

  const run = async (b: Blocker) => {
    if (!b.action || b.action.kind === "link_repo") return;
    const a = b.action;
    setBusy(b.id);
    try {
      const grantId = a.kind === "approve" && a.passkey ? await stepUp("approve_integration", approvalTarget(a.cap, b.projectId)) : undefined;
      const r = await act({ data: { cap: a.cap, projectId: b.projectId, op: a.kind, grantId } });
      if (r.status === "connected") toast.success(`Verified. ${r.resumed} waiting task(s) resumed.`);
      else toast.error(`Not connected yet: ${r.detail}`);
    } catch (e) { toast.error((e as Error).message); }
    setBusy(null); void refresh();
  };

  return (
    <>
      <PageHeader title="Blocker Queue" subtitle="Everything stopping your connected projects, worked out from real connection checks and queued tasks." />
      {err && <p className="panel mb-4 p-4 text-sm text-destructive">{err}</p>}
      {!d && !err && <p className="text-sm text-muted-foreground">Checking projects…</p>}
      {d && d.blockers.length === 0 && <p className="panel p-5 text-sm text-success">No blockers on connected projects.</p>}
      {d && d.blockers.length > 0 && (
        <ul className="space-y-3">
          {d.blockers.map((b) => (
            <li key={b.id} className="panel p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Link to="/project/$id" params={{ id: b.projectId }} className="font-semibold hover:text-electric">{b.projectName}</Link>
                <span className={`text-xs ${STATUS[b.status][1]}`}>{STATUS[b.status][0]}</span>
                <span className={`ml-auto rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${b.risk === "Critical" ? "border-destructive/50 text-destructive" : "border-border text-silver"}`}>{b.risk}</span>
              </div>
              <dl className="mt-2 grid gap-1 text-xs md:grid-cols-[8rem_1fr]">
                <dt className="text-muted-foreground">Cause</dt><dd>{b.cause}</dd>
                <dt className="text-muted-foreground">Missing</dt><dd>{b.missing}</dd>
                <dt className="text-muted-foreground">Fix</dt><dd>{b.remedy}</dd>
                {b.waitingTasks.length > 0 && <><dt className="text-muted-foreground">Waiting work</dt><dd>{b.waitingTasks.join(" · ")}</dd></>}
              </dl>
              <div className="mt-3 flex gap-2">
                {b.action?.kind === "approve" && <button className={btn} disabled={busy !== null} onClick={() => run(b)}>{busy === b.id ? "Working…" : b.action.passkey ? "Approve with passkey & check" : "Approve & check"}</button>}
                {b.action?.kind === "verify" && <button className={btn} disabled={busy !== null} onClick={() => run(b)}>{busy === b.id ? "Checking…" : "Check again"}</button>}
                {b.action?.kind === "link_repo" && <Link to="/project/$id" params={{ id: b.projectId }} className={btn}>Link repo</Link>}
                {b.id.startsWith("task:") && <Link to="/foundry" className={btn}>Open Code Foundry</Link>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wider text-silver">History</h2>
      <ul className="panel space-y-1 p-4 font-mono text-xs">
        {!d?.history.length && <li className="text-muted-foreground">No approvals or checks recorded yet.</li>}
        {d?.history.map((h) => <li key={h.id}>{new Date(h.created_at).toLocaleString()} · <span className={h.status === "ok" ? "text-success" : h.status === "blocked" ? "text-destructive" : ""}>{h.status}</span> · {h.summary}</li>)}
      </ul>
    </>
  );
}

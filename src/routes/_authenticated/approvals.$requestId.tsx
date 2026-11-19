import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { ApprovalCard } from "@/components/ApprovalCard";
import { getApprovalCard } from "@/lib/approval-card.functions";

export const Route = createFileRoute("/_authenticated/approvals/$requestId")({
  head: () => ({
    meta: [
      { title: "Approval card — Jackboy" },
      { name: "description", content: "One pending Jackboy approval: what will run, the cost cap, the expiry and the recorded outcome." },
      { property: "og:title", content: "Approval card — Jackboy" },
      { property: "og:description", content: "Review one Jackboy approval request. Opening this page never approves anything." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ApprovalCardPage,
});

type ApprovalCardResult = Awaited<ReturnType<typeof getApprovalCard>>;
type CardDetails = Extract<ApprovalCardResult, { state: "pending" }>["card"];

function useCountdown(expiresAt: string | null) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setLeft(Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000)));
    tick(); const t = setInterval(tick, 1000); return () => clearInterval(t);
  }, [expiresAt]);
  return left;
}

function NoLongerValid({ detail }: { detail?: string }) {
  return (
    <section className="panel p-4 text-sm">
      <p className="font-semibold">This link is no longer valid.</p>
      <p className="mt-1 text-muted-foreground">{detail ?? "Nothing was changed."}</p>
      <Link to="/updates" className="mt-3 inline-block text-xs text-electric hover:underline">Open Approvals</Link>
    </section>
  );
}

function Details({ card, left }: { card: CardDetails; left: number | null }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
      <dt className="text-muted-foreground">Request</dt><dd className="font-mono text-xs">{card.id}</dd>
      <dt className="text-muted-foreground">Target</dt><dd>{card.target}</dd>
      <dt className="text-muted-foreground">What will run</dt>
      <dd><ul className="list-disc pl-4">{card.whatRuns.map((w, i) => <li key={i} className="whitespace-pre-wrap">{w}</li>)}</ul></dd>
      <dt className="text-muted-foreground">Cost cap</dt><dd>{card.costCap}</dd>
      <dt className="text-muted-foreground">Expires</dt>
      <dd>{left === null ? new Date(card.expiresAt).toLocaleString() : left > 0 ? `in ${Math.floor(left / 60)}m ${left % 60}s` : "Expired — nothing can be approved from this link."}</dd>
      {card.diffSummary && <><dt className="text-muted-foreground">Changes</dt><dd><pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">{card.diffSummary}</pre></dd></>}
    </dl>
  );
}

function ApprovalCardPage() {
  const { requestId } = Route.useParams();
  const load = useServerFn(getApprovalCard);
  const [d, setD] = useState<ApprovalCardResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = useCallback(() => { setErr(null); return load({ data: { id: requestId } }).then(setD).catch((e) => setErr((e as Error).message)); }, [load, requestId]);
  useEffect(() => { void refresh(); }, [refresh]);
  const left = useCountdown(d?.state === "pending" ? d.card.expiresAt : null);

  const header = <PageHeader title="Approval card" subtitle="Opening this page never approves, starts or changes anything." />;
  if (err) return <>{header}<p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{err}</p></>;
  if (!d) return <>{header}<p className="text-sm text-muted-foreground">Loading…</p></>;
  if (d.state === "invalid") return <>{header}<NoLongerValid /></>;
  if (d.state === "expired") return <>{header}<NoLongerValid detail="It expired before a decision. Nothing was changed; ask again if it's still needed." /></>;
  if (d.state === "unavailable") return <>{header}<p role="alert" className="rounded-md border border-warning/40 p-3 text-sm">{d.reason}</p></>;

  if (d.state === "decided") {
    const o = d.outcome;
    return (
      <>
        {header}
        <NoLongerValid detail={`Already ${d.status}${d.decidedAt ? ` on ${new Date(d.decidedAt).toLocaleString()}` : ""}. It can't be decided again.`} />
        <section className="panel mt-4 space-y-3 p-4 text-sm">
          <p className="font-semibold">{d.card.title}</p>
          <Details card={d.card} left={null} />
          <div className={`rounded-md border p-3 ${o.readFailed ? "border-warning/40" : "border-border"}`}>
            <p className="text-xs uppercase text-muted-foreground">Recorded outcome</p>
            <p className="mt-1">{o.summary}</p>
            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              {o.prUrl && <a href={o.prUrl} target="_blank" rel="noreferrer" className="text-electric hover:underline">Open draft pull request</a>}
              {o.runUrl && <a href={o.runUrl} target="_blank" rel="noreferrer" className="text-electric hover:underline">Open GitHub run</a>}
              <button className="text-muted-foreground hover:text-foreground" onClick={() => void refresh()}>Refresh</button>
            </div>
          </div>
        </section>
      </>
    );
  }

  const c = d.card;
  const expired = left === 0;
  return (
    <>
      {header}
      {msg && <p className="mb-4 rounded-md border border-border p-3 text-sm">{msg}</p>}
      <section className="panel space-y-4 p-4">
        <p className="font-semibold">{c.title} <span className="text-xs uppercase text-muted-foreground">· {c.tier}</span></p>
        <Details card={c} left={left} />
        {d.decideBlocked && <p role="alert" className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{d.decideBlocked} Approvals stay blocked until it's off.</p>}
        {!d.decideBlocked && !expired && c.kind === "foundry" && c.taskId && (
          <div className="flex flex-wrap items-start gap-2">
            <ApprovalCard taskId={c.taskId} action={c.action === "read_checks" ? "read_checks" : "open_draft_pr"} expectId={c.id} onDone={(m) => { setMsg(m); void refresh(); }} />
          </div>
        )}
        {!d.decideBlocked && !expired && c.kind === "code" && (
          <div className="rounded-md border border-border p-3 text-sm">
            <p>CODE approvals stay tied to the sign-in that asked for them. Allow or Deny it in Chat on that device.</p>
            <Link to="/chat" className="mt-2 inline-block rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">Open Chat</Link>
          </div>
        )}
      </section>
    </>
  );
}

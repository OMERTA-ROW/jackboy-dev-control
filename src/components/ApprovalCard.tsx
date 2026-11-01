import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { decideAction, requestAction } from "@/lib/foundry.functions";
import { useStepUp } from "@/lib/step-up-client";

type Card = Awaited<ReturnType<typeof requestAction>>;
const TIER: Record<string, string> = { routine: "text-success", controlled: "text-electric", critical: "text-destructive" };

/** Precise approval card: action ID, target, permissions, diff/risk, expiry, Allow Once / Allow for This Task / Deny. */
export function ApprovalCard({ taskId, onDone }: { taskId: string; onDone: (msg: string) => void }) {
  const req = useServerFn(requestAction), decide = useServerFn(decideAction), stepUp = useStepUp();
  const [card, setCard] = useState<Card | null>(null);
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false); const [left, setLeft] = useState(0);
  const open = async () => { setErr(""); try { setCard(await req({ data: { taskId, action: "open_draft_pr" } })); } catch (e) { setErr((e as Error).message); } };
  useEffect(() => {
    if (!card) return;
    const tick = () => setLeft(Math.max(0, Math.round((new Date(card.expires_at).getTime() - Date.now()) / 1000)));
    tick(); const t = setInterval(tick, 1000); return () => clearInterval(t);
  }, [card]);
  const go = async (decision: "allow_once" | "allow_task" | "deny") => {
    if (!card || busy) return; setBusy(true); setErr("");
    try {
      const grantId = card.tier === "critical" && decision !== "deny" ? await stepUp("critical_change", card.id) : undefined;
      const r = await decide({ data: { id: card.id, nonce: card.nonce, decision, ...(grantId ? { grantId } : {}) } });
      setCard(null);
      onDone(r.status === "denied" ? "Denied. Task rejected." : r.outcome === "completed" ? "Allowed. Draft pull request opened and verified." : `Allowed, but the action needs attention: ${r.outcome}`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (!card) return <><button className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground" onClick={open}>Review approval</button>{err && <p role="alert" className="w-full text-xs text-destructive">{err}</p>}</>;
  const res = card.resources as { repo?: string; branch?: string; files?: string[] };
  return (
    <div role="dialog" aria-label="Approval request" className="w-full rounded-md border border-primary/40 p-3 text-xs">
      <p className="font-semibold">{card.title}</p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Action ID</dt><dd className="font-mono">{card.id}</dd>
        <dt className="text-muted-foreground">Action</dt><dd>{card.action} · <span className={`font-semibold uppercase ${TIER[card.tier]}`}>{card.tier}</span> · risk {card.risk}</dd>
        <dt className="text-muted-foreground">Target</dt><dd>{res.repo} · {res.branch}</dd>
        <dt className="text-muted-foreground">Permissions</dt><dd>{card.permissions.join("; ")}</dd>
        <dt className="text-muted-foreground">Expires</dt><dd>{left > 0 ? `${Math.floor(left / 60)}m ${left % 60}s` : "Expired. Reopen to ask again."}</dd>
      </dl>
      {card.diff_summary && <pre className="mt-2 max-h-32 overflow-auto rounded bg-muted p-2">{card.diff_summary}</pre>}
      {card.tier === "critical" && <p className="mt-2 text-warning">Critical: allowing asks for your passkey. Voice can't approve this.</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground disabled:opacity-50" disabled={busy || left === 0} onClick={() => go("allow_once")}>Allow once</button>
        {card.tier !== "critical" && <button className="rounded-md border border-border px-3 py-1.5 disabled:opacity-50" disabled={busy || left === 0} onClick={() => go("allow_task")}>Allow for this task</button>}
        <button className="rounded-md border border-destructive/50 px-3 py-1.5 text-destructive disabled:opacity-50" disabled={busy || left === 0} onClick={() => go("deny")}>Deny</button>
      </div>
      {err && <p role="alert" className="mt-2 text-destructive">{err}</p>}
    </div>
  );
}

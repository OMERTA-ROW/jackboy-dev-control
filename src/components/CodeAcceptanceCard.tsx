import { useState } from "react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useStepUp } from "@/lib/step-up-client";
import type { CodeCard } from "@/lib/code";
import {
  ACCEPTANCE_FILE,
  ACCEPTANCE_REPO,
  acceptanceBlockReason,
  acceptanceInstruction,
  acceptanceTarget,
  type AcceptanceGates,
} from "@/lib/code-acceptance";

async function call(body?: unknown, id?: string): Promise<CodeCard> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new Error("Sign in to use CODE.");
  const r = await fetch(id ? `/api/code?id=${encodeURIComponent(id)}` : "/api/code", {
    method: id ? "GET" : "POST",
    headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" },
    ...(id ? {} : { body: JSON.stringify(body) }),
  });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error ?? "CODE request failed.");
  return result as CodeCard;
}

/** One-time $1 docs-only CODE acceptance test. Never starts on its own; the server re-checks every gate. */
export function CodeAcceptanceCard({ gates }: { gates: AcceptanceGates }) {
  const stepUp = useStepUp();
  const [card, setCard] = useState<CodeCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const blocked = acceptanceBlockReason(gates);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "Acceptance test failed."); }
    finally { setBusy(false); }
  };
  const start = () => guard(async () => {
    const result = await stepUp("code_acceptance_test", acceptanceTarget(ACCEPTANCE_REPO), {
      applyingText: "Passkey confirmed. Creating the acceptance test request…",
      apply: (grantId) => call({ op: "acceptance", grantId }),
      doneText: () => "Request created. Press Allow to dispatch it to GitHub.",
    });
    if (result && typeof result === "object" && "id" in (result as object)) setCard(result as CodeCard);
  });
  const decide = (decision: "allow" | "deny") => guard(async () => {
    if (!card?.nonce) throw new Error("This request can no longer be decided here.");
    const next = await call({ op: "decide", id: card.id, nonce: card.nonce, decision });
    setCard(next);
  });
  const refresh = () => guard(async () => {
    if (!card) return;
    const fresh = await call(undefined, card.id);
    setCard(card.nonce ? { ...fresh, nonce: card.nonce } : fresh);
  });

  return (
    <div className="mt-4 rounded-md border border-border p-3" aria-labelledby="acceptance-heading">
      <h3 id="acceptance-heading" className="text-sm font-semibold">First $1 CODE acceptance test</h3>
      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
        <li>Target: <code>{ACCEPTANCE_REPO}</code> · main · reviewed lane only</li>
        <li>Fixed task (not editable): {acceptanceInstruction(new Date())}</li>
        <li>Money set aside: up to ${gates.perTaskReserveUsd ?? "?"} · limits $5/day, $10 total</li>
        <li>Result: a draft PR changing only <code>{ACCEPTANCE_FILE}</code>. Nothing is merged or published.</li>
        <li>Steps: passkey → Allow → approve the <code>CODE</code> environment in GitHub Actions.</li>
      </ul>
      {blocked && !card && <p className="mt-2 text-xs text-warning">Can't start: {blocked}</p>}
      {!card && (
        <Button size="sm" className="mt-3" disabled={busy || blocked !== null} onClick={() => void start()}>
          Start $1 test with passkey
        </Button>
      )}
      {card && (
        <div className="mt-3 space-y-2 text-xs">
          <p>Request <code>{card.id}</code> · status <strong>{card.status}</strong></p>
          {card.status === "pending" && (
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void decide("allow")}>Allow (dispatch to GitHub)</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void decide("deny")}>Deny</Button>
            </div>
          )}
          {card.run && (
            <p>
              GitHub run: <a className="underline" href={card.run.url} target="_blank" rel="noreferrer">{card.run.status}{card.run.conclusion ? ` · ${card.run.conclusion}` : ""}</a>
              {card.run.pr && <> · <a className="underline" href={card.run.pr} target="_blank" rel="noreferrer">draft PR</a></>}
            </p>
          )}
          {card.acceptance && (
            <p className={card.acceptance.ok ? "text-success" : "text-warning"}>
              Docs-only check: {card.acceptance.ok === null ? "waiting for the draft PR" : card.acceptance.ok ? "passed" : `FAILED — ${card.acceptance.reasons.join(" ")}`}
            </p>
          )}
          {card.outcome && <p className="text-muted-foreground">{card.outcome}</p>}
          {card.status !== "pending" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>Refresh evidence</Button>}
          <p className="text-muted-foreground">After the run: spending and provider calls appear under CODE safety; the OpenAI cost cross-check runs about 6 hours after the UTC day closes.</p>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-warning">{error}</p>}
    </div>
  );
}

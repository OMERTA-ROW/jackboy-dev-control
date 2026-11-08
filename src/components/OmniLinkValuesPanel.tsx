import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Copy, Eye, EyeOff, KeyRound, ShieldAlert } from "lucide-react";
import { getOmniLinkValueStatus, revealOmniLinkValues } from "@/lib/omni-link-values.functions";
import { REVEAL_ACTION, REVEAL_TARGET, suggestApproval, type LinkValueName } from "@/lib/omni-link-values";
import { useStepUp } from "@/lib/step-up-client";

type Status = Awaited<ReturnType<typeof getOmniLinkValueStatus>>;
type Revealed = Awaited<ReturnType<typeof revealOmniLinkValues>>;
const HIDE_AFTER_MS = 2 * 60_000;

function CopyRow({ name, value, note }: { name: string; value: string | null; note?: string | null }) {
  const [done, setDone] = useState(false);
  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-silver">{name}</span>
        {value && (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:border-electric"
            onClick={() =>
              void navigator.clipboard.writeText(value).then(() => {
                setDone(true);
                window.setTimeout(() => setDone(false), 1500);
              })
            }
          >
            <Copy className="h-3 w-3" aria-hidden />
            {done ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      <div className="mt-1 break-all font-mono text-sm">{value ?? <span className="text-muted-foreground">Not set in Jackboy</span>}</div>
      {note && <p className="mt-1 text-xs text-warning">{note}</p>}
    </li>
  );
}

/** Owner-only: the three values OMNI on Railway must match. Showing them needs a fresh passkey. */
export function OmniLinkValuesPanel() {
  const load = useServerFn(getOmniLinkValueStatus), reveal = useServerFn(revealOmniLinkValues);
  const stepUp = useStepUp();
  const [status, setStatus] = useState<Status | null>(null);
  const [shown, setShown] = useState<Revealed | null>(null);
  const [fresh, setFresh] = useState<ReturnType<typeof suggestApproval> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => load().then(setStatus).catch((e: Error) => setMsg(e.message)), [load]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!shown) return;
    const t = window.setTimeout(() => { setShown(null); setFresh(null); }, HIDE_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [shown]);

  const s = status?.summary;
  const problem = (n: LinkValueName) => shown?.summary.checks.find((c) => c.name === n)?.problem ?? null;
  const needsNewApproval = shown && (shown.summary.expiry !== "valid" || !shown.values.OMNI_LINK_APPROVAL_ID);

  return (
    <section className="panel mb-4 space-y-3 p-4 text-sm" aria-labelledby="omni-link-values">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="h-4 w-4 text-electric" aria-hidden />
        <h2 id="omni-link-values" className="font-semibold">OMNI link values for Railway</h2>
        <span className="text-xs text-muted-foreground">Owner only</span>
      </div>
      <p className="text-muted-foreground">
        OMNI on Railway must use exactly the same owner ID, approval ID and approval expiry as Jackboy. Showing them needs a new passkey check each time, and they hide again after 2 minutes.
      </p>

      {s && (
        <ul className="space-y-1">
          {s.checks.map((c) => (
            <li key={c.name} className="flex flex-wrap items-center gap-2">
              {c.ok ? <CheckCircle2 className="h-4 w-4 text-success" aria-hidden /> : <ShieldAlert className="h-4 w-4 text-warning" aria-hidden />}
              <span className="font-mono text-xs">{c.name}</span>
              <span className={c.ok ? "text-xs text-success" : "text-xs text-warning"}>{c.ok ? "Set and valid" : c.problem}</span>
              {c.name === "OMNI_LINK_APPROVAL_EXPIRES_AT" && s.expiresInMs !== null && (
                <span className="text-xs text-muted-foreground">
                  {s.expiresInMs > 0 ? `· ${Math.floor(s.expiresInMs / 3_600_000)} h left` : `· ended ${Math.round(-s.expiresInMs / 3_600_000)} h ago`}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {status && (
        <p className="text-xs text-muted-foreground">
          Link switch on Jackboy: {status.linkEnabled ? "on" : "off"}. This view never turns it on or runs the self-test.
        </p>
      )}

      {!shown ? (
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md border border-electric px-3 py-1.5 hover:bg-muted disabled:opacity-50"
          disabled={busy}
          onClick={async () => {
            setBusy(true); setMsg(null);
            try {
              const r = await stepUp(REVEAL_ACTION, REVEAL_TARGET, {
                apply: (grantId) => reveal({ data: { grantId } }),
                applyingText: "Passkey confirmed. Loading the values…",
                doneText: () => "Values shown below.",
              });
              setShown(r);
            } catch (e) {
              setMsg((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Eye className="h-4 w-4" aria-hidden /> Show values with passkey
        </button>
      ) : (
        <div className="space-y-3">
          <ul className="space-y-2">
            <CopyRow name="OMNI_LINK_OWNER_ID" value={shown.values.OMNI_LINK_OWNER_ID} note={problem("OMNI_LINK_OWNER_ID")} />
            <CopyRow name="OMNI_LINK_APPROVAL_ID" value={shown.values.OMNI_LINK_APPROVAL_ID} note={problem("OMNI_LINK_APPROVAL_ID")} />
            <CopyRow name="OMNI_LINK_APPROVAL_EXPIRES_AT" value={shown.values.OMNI_LINK_APPROVAL_EXPIRES_AT} note={problem("OMNI_LINK_APPROVAL_EXPIRES_AT")} />
          </ul>
          {!shown.summary.ownerMatchesYou && (
            <div className="rounded-md border border-warning/50 p-3">
              <p className="text-xs">Your owner account ID (use this for OMNI_LINK_OWNER_ID in both places):</p>
              <ul className="mt-2"><CopyRow name="Your owner ID" value={shown.yourOwnerId} /></ul>
            </div>
          )}
          {needsNewApproval && (
            <div className="space-y-2 rounded-md border border-warning/50 p-3">
              <p className="text-xs">
                The approval is missing or no longer valid, so copying it to Railway will not work. Make a new pair below, then save the same two values in Jackboy's secret settings and in Railway. Nothing is saved by this button.
              </p>
              {!fresh ? (
                <button type="button" className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted" onClick={() => setFresh(suggestApproval())}>
                  Make a new approval (valid 23 hours)
                </button>
              ) : (
                <ul className="space-y-2">
                  <CopyRow name="New OMNI_LINK_APPROVAL_ID" value={fresh.approvalId} />
                  <CopyRow name="New OMNI_LINK_APPROVAL_EXPIRES_AT" value={fresh.expiresAt} />
                </ul>
              )}
            </div>
          )}
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
            onClick={() => { setShown(null); setFresh(null); void refresh(); }}
          >
            <EyeOff className="h-4 w-4" aria-hidden /> Hide values
          </button>
        </div>
      )}
      {msg && <p role="alert" className="text-xs text-destructive">{msg}</p>}
    </section>
  );
}

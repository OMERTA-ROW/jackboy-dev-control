import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Copy, Eye, EyeOff, KeyRound, ShieldAlert } from "lucide-react";
import { getOmniLinkValueStatus, revealOmniLinkValues, saveOmniLinkApproval } from "@/lib/omni-link-values.functions";
import { APPROVAL_SOURCE_TEXT, SAVE_APPROVAL_ACTION, SAVE_APPROVAL_TARGET } from "@/lib/omni-link-approval";
import { expiryHint, REVEAL_ACTION, REVEAL_TARGET, suggestApproval, type LinkValueName } from "@/lib/omni-link-values";
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
  const load = useServerFn(getOmniLinkValueStatus), reveal = useServerFn(revealOmniLinkValues), save = useServerFn(saveOmniLinkApproval);
  const [draft, setDraft] = useState({ approvalId: "", expiresAt: "" });
  const [saved, setSaved] = useState<string | null>(null);
  const stepUp = useStepUp();
  const [status, setStatus] = useState<Status | null>(null);
  const [shown, setShown] = useState<Revealed | null>(null);
  const [fresh, setFresh] = useState<ReturnType<typeof suggestApproval> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const refresh = useCallback(
    () => load().then((r) => { setStatus(r); setCheckedAt(new Date()); setMsg(null); }).catch((e: Error) => setMsg(e.message)),
    [load],
  );
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
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
            </li>
          ))}
        </ul>
      )}
      {s && <p className="text-xs text-muted-foreground">{expiryHint(s.expiry, s.expiresInMs)}</p>}
      {status && (
        <p className={status.approval.source === "unavailable" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          Approval source: {APPROVAL_SOURCE_TEXT[status.approval.source]}
          {status.approval.savedAt && ` · saved ${new Date(status.approval.savedAt).toLocaleString()}`}
        </p>
      )}
      {status && (
        <p className="text-xs text-muted-foreground">
          Link switch on Jackboy: {status.linkEnabled ? "on" : "off"}. This shows only what Jackboy has saved; it does not read Railway, prove OMNI is connected, turn the link on or run the self-test.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <button type="button" className="rounded-md border border-border px-2 py-1 hover:bg-muted" onClick={() => void refresh()}>
          Recheck saved values
        </button>
        {checkedAt && <span>Checked at {checkedAt.toLocaleTimeString()}</span>}
      </div>

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
          <div className={`space-y-2 rounded-md border p-3 ${needsNewApproval ? "border-warning/50" : "border-border"}`}>
            <p className="text-xs font-medium">Save an approval in Jackboy</p>
            <p className="text-xs">
              {needsNewApproval ? "The approval Jackboy uses is missing or no longer valid. " : ""}
              Paste the approval ID and expiry Railway already has, or make a new pair. Saving needs a new passkey check, stores both together, and replaces the old project settings for the link. It does not turn the link on, give OMNI project access, or change Railway.
            </p>
            <button type="button" className="rounded-md border border-border px-3 py-1 text-xs hover:bg-muted" onClick={() => { const f = suggestApproval(); setFresh(f); setDraft(f); }}>
              Make a new approval (valid 23 hours)
            </button>
            {fresh && <p className="text-xs text-muted-foreground">New pair filled in below. Nothing is saved until you press Save.</p>}
            <label className="block text-xs">
              <span className="font-mono">OMNI_LINK_APPROVAL_ID</span>
              <input className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-sm" value={draft.approvalId} onChange={(e) => setDraft({ ...draft, approvalId: e.target.value.trim() })} autoComplete="off" spellCheck={false} />
            </label>
            <label className="block text-xs">
              <span className="font-mono">OMNI_LINK_APPROVAL_EXPIRES_AT</span>
              <input className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-sm" value={draft.expiresAt} onChange={(e) => setDraft({ ...draft, expiresAt: e.target.value.trim() })} placeholder="2026-11-09T07:00:00.000Z" autoComplete="off" spellCheck={false} />
            </label>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md border border-electric px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
              disabled={busy || !draft.approvalId || !draft.expiresAt}
              onClick={async () => {
                setBusy(true); setMsg(null); setSaved(null);
                try {
                  const r = await stepUp(SAVE_APPROVAL_ACTION, SAVE_APPROVAL_TARGET, {
                    apply: (grantId) => save({ data: { grantId, ...draft } }),
                    applyingText: "Passkey confirmed. Saving the approval…",
                    doneText: () => "Approval saved in Jackboy.",
                  });
                  setStatus(r); setCheckedAt(new Date());
                  setShown((cur) => cur && { ...cur, summary: r.summary, approval: r.approval, values: { ...cur.values, OMNI_LINK_APPROVAL_ID: draft.approvalId.toLowerCase(), OMNI_LINK_APPROVAL_EXPIRES_AT: new Date(Date.parse(draft.expiresAt)).toISOString() } });
                  setSaved(`Saved and read back at ${new Date().toLocaleTimeString()}. Railway is not updated automatically — do the steps below.`);
                } catch (e) {
                  setMsg((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <KeyRound className="h-4 w-4" aria-hidden /> Save approval with passkey
            </button>
            {saved && <p role="status" className="text-xs text-success">{saved}</p>}
            <ol className="list-decimal space-y-1 pl-5 text-xs">
              <li>Save the pair here with your passkey (works on the published site after publishing this update).</li>
              <li>In Railway, set OMNI_LINK_APPROVAL_ID and OMNI_LINK_APPROVAL_EXPIRES_AT on OMNI to exactly the same text, then redeploy OMNI. Jackboy cannot do this for you.</li>
              <li>Press “Recheck saved values”. It should say “Set and valid” with source “Saved in Jackboy”. That still does not prove OMNI is connected — only a real OMNI session does.</li>
            </ol>
            <p className="text-xs text-muted-foreground">An approval lasts at most 24 hours, so finish the Railway step soon after saving.</p>
          </div>
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

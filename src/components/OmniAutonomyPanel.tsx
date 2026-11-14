import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, KeyRound, OctagonX, RefreshCw, ShieldAlert, XCircle } from "lucide-react";
import { authorizeOmniAutonomy, getOmniAutonomyStatus, revokeOmniAutonomy } from "@/lib/omni-autonomy.functions";
import { AUTONOMY_STEP_UP_ACTION, OMNI_AUTONOMY_LIMITS, autonomyTarget, permitReasonText, type Gate } from "@/lib/omni-permit";
import { useStepUp } from "@/lib/step-up-client";

type Status = Awaited<ReturnType<typeof getOmniAutonomyStatus>>;

function GateList({ gates }: { gates: Gate[] }) {
  return (
    <ul className="space-y-1">
      {gates.map((g) => (
        <li key={g.id} className="flex flex-wrap items-center gap-2 text-xs">
          {g.ok ? <CheckCircle2 className="h-4 w-4 text-success" aria-hidden /> : <XCircle className="h-4 w-4 text-destructive" aria-hidden />}
          <span className="font-medium">{g.label}</span>
          <span className={g.ok ? "text-muted-foreground" : "text-destructive"}>{g.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/** Owner-only: Jackboy's permission for OMNI autonomous/CODE work. Refreshes every 15 s. */
export function OmniAutonomyPanel() {
  const load = useServerFn(getOmniAutonomyStatus);
  const authorize = useServerFn(authorizeOmniAutonomy);
  const revoke = useServerFn(revokeOmniAutonomy);
  const stepUp = useStepUp();
  const [s, setS] = useState<Status | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(
    () => load().then((r) => { setS(r); setLoadError(null); }).catch((e: Error) => setLoadError(e.message)),
    [load],
  );
  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const active = s?.permits.filter((p) => p.status === "active") ?? [];

  return (
    <section className="panel mb-4 space-y-3 p-4 text-sm" aria-labelledby="omni-autonomy">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="h-4 w-4 text-electric" aria-hidden />
        <h2 id="omni-autonomy" className="font-semibold">Jackboy permission for OMNI autonomous work</h2>
        <span className="text-xs text-muted-foreground">Owner only</span>
        <button type="button" className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted" onClick={() => void refresh()}>
          <RefreshCw className="h-3 w-3" aria-hidden /> Recheck
        </button>
      </div>
      <p className="text-muted-foreground">
        Jackboy holds the key. OMNI may run an autonomous or CODE job only while it holds a Jackboy permit that lasts at most 60 seconds and must be renewed. Every renewal re-checks the Kill Switch, the CODE Emergency Stop and the CODE setting, so a stop in Settings → Activation halts OMNI within a minute once the Mothership follows the permit contract. A Step 10 approval on the Mothership never overrides this.
      </p>

      {loadError && <p className="text-xs text-destructive">Could not read the current state: {loadError}. Treat OMNI as blocked.</p>}
      {s && (
        <>
          <div className={`rounded-md border p-3 ${s.gates.omniCanRun ? "border-success/50" : "border-destructive/50"}`}>
            <p className="flex items-center gap-2 font-medium">
              {s.gates.omniCanRun ? <CheckCircle2 className="h-4 w-4 text-success" aria-hidden /> : <OctagonX className="h-4 w-4 text-destructive" aria-hidden />}
              {s.gates.omniCanRun ? "OMNI can get permits right now" : "OMNI cannot run autonomous or CODE work right now"}
            </p>
            <div className="mt-2"><GateList gates={s.gates.run} /></div>
            <p className="mt-2 text-xs text-muted-foreground">
              Change the Kill Switch, CODE setting and Emergency Stop in Settings → Activation. Nothing here changes them.
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium">Before you can authorize</p>
            <GateList gates={s.gates.authorize} />
          </div>

          {s.authorizationDetail ? (
            <div className="rounded-md border border-border p-3 text-xs">
              <p>
                Authorized {new Date(s.authorizationDetail.createdAt).toLocaleString()} until {new Date(s.authorizationDetail.expiresAt).toLocaleString()} (the end of the Step 7 window).
              </p>
              <p className="text-muted-foreground">
                Limits: ${s.authorizationDetail.limits.dailyUsd.toFixed(2)} per day · ${s.authorizationDetail.limits.perCallUsd.toFixed(2)} per AI call · ${s.authorizationDetail.limits.perTaskUsd.toFixed(2)} reserved per job · one job at a time.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Not authorized. Limits that will apply: ${OMNI_AUTONOMY_LIMITS.dailyUsd.toFixed(2)} per day, ${OMNI_AUTONOMY_LIMITS.perCallUsd.toFixed(2)} per AI call, ${OMNI_AUTONOMY_LIMITS.perTaskUsd.toFixed(2)} reserved per job.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md border border-electric px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
              disabled={busy || !s.gates.canAuthorize || !s.approval}
              title={s.gates.canAuthorize ? undefined : "Every check above must pass first"}
              onClick={async () => {
                if (!s.approval) return;
                setBusy(true); setMsg(null);
                try {
                  const r = await stepUp(AUTONOMY_STEP_UP_ACTION, autonomyTarget(s.approval.approvalId), {
                    apply: (grantId) => authorize({ data: { grantId } }),
                    applyingText: "Passkey confirmed. Recording your permission…",
                    doneText: () => "Done.",
                  });
                  if (!r.ok) setMsg({ ok: false, text: `Not authorized: ${(r.reasons ?? []).map(permitReasonText).join("; ")}.` });
                  else {
                    const blocked = r.executionBlockedBy ?? [];
                    setMsg({
                      ok: true,
                      text: `${r.duplicate ? "Already authorized" : "Authorized"} until ${new Date(r.expiresAt!).toLocaleString()}.${blocked.length ? ` OMNI still cannot run because ${blocked.map(permitReasonText).join(", ")}.` : ""}`,
                    });
                  }
                } catch (e) {
                  setMsg({ ok: false, text: (e as Error).message });
                } finally {
                  setBusy(false);
                  void refresh();
                }
              }}
            >
              <KeyRound className="h-4 w-4" aria-hidden /> Authorize OMNI autonomous work with passkey
            </button>
            {s.authorizationDetail && (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md border border-destructive px-3 py-1.5 text-xs text-destructive hover:bg-muted disabled:opacity-50"
                disabled={busy}
                onClick={async () => {
                  setBusy(true); setMsg(null);
                  try {
                    const r = await revoke();
                    setMsg({ ok: true, text: `Revoked. ${r.revokedPermits} active permit(s) closed; OMNI must stop at its next check.` });
                  } catch (e) {
                    setMsg({ ok: false, text: (e as Error).message });
                  } finally {
                    setBusy(false);
                    void refresh();
                  }
                }}
              >
                <ShieldAlert className="h-4 w-4" aria-hidden /> Revoke now
              </button>
            )}
          </div>
          {msg && <p className={msg.ok ? "text-xs text-success" : "text-xs text-destructive"} role="status">{msg.text}</p>}

          <div className="space-y-1">
            <p className="text-xs font-medium">Permits ({active.length} active)</p>
            {s.permits.length === 0 ? (
              <p className="text-xs text-muted-foreground">{s.installed === true ? "No permits issued yet." : s.installed === false ? "Permit service not installed yet." : "Couldn't read permits right now."}</p>
            ) : (
              <ul className="space-y-1">
                {s.permits.map((p) => (
                  <li key={p.id} className="text-xs">
                    <span className="font-mono">{p.job_id.slice(0, 8)}</span> · {p.job_kind} · <span className={p.status === "active" ? "text-success" : "text-muted-foreground"}>{p.status}</span>
                    {" "}· issued {new Date(p.issued_at).toLocaleTimeString()}
                    {p.status === "active" ? ` · until ${new Date(p.expires_at).toLocaleTimeString()} · renewed ${p.renewals}×` : p.closed_reason ? ` · ${permitReasonText(p.closed_reason)}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-xs text-muted-foreground">Checked {new Date(s.checkedAt).toLocaleTimeString()}.</p>
        </>
      )}
    </section>
  );
}

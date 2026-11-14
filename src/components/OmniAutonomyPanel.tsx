import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, KeyRound, OctagonX, RefreshCw, ShieldAlert, XCircle } from "lucide-react";
import {
  authorizeOmniAutonomy,
  getOmniAutonomyStatus,
  revokeOmniAutonomy,
} from "@/lib/omni-autonomy.functions";
import {
  AUTONOMY_STEP_UP_ACTION,
  OMNI_AUTONOMY_LIMITS,
  OMNI_CAPABILITIES,
  OMNI_CAPABILITY_LABELS,
  authorizationReview,
  autonomyTarget,
  canRecordScope,
  permitReasonText,
  type Gate,
  type OmniCapability,
  type ReviewRow,
} from "@/lib/omni-permit";
import { useStepUp } from "@/lib/step-up-client";
import { UnifiedOmniStatus } from "./UnifiedOmniStatus";

type Status = Awaited<ReturnType<typeof getOmniAutonomyStatus>>;

const capText = (caps: readonly string[] | null) =>
  caps && caps.length ? caps.join(" + ") : "unknown (couldn't read)";
const AUDIT_LABELS: Record<string, string> = {
  "omni.autonomy_authorized": "Authorized",
  "omni.autonomy_scope": "Allowed job kinds saved",
  "omni.autonomy_authorize_refused": "Authorization refused",
  "omni.autonomy_revoked": "Revoked",
  "omni.permits_revoked": "Permits closed by a stop",
};

function ReviewSection({ title, rows }: { title: string; rows: ReviewRow[] }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{title}</p>
      <dl className="grid grid-cols-[minmax(0,14rem)_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map((r) => (
          <div key={r.label} className="contents">
            <dt className="flex items-center gap-1 text-muted-foreground">
              {r.ok === true ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
              ) : r.ok === false ? (
                <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
              ) : (
                <span className="inline-block h-3.5 w-3.5 shrink-0" aria-hidden />
              )}
              {r.label}
            </dt>
            <dd className={`break-all ${r.ok === false ? "text-destructive" : ""}`}>{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function GateList({ gates }: { gates: Gate[] }) {
  return (
    <ul className="space-y-1">
      {gates.map((g) => (
        <li key={g.id} className="flex flex-wrap items-center gap-2 text-xs">
          {g.ok ? (
            <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
          ) : (
            <XCircle className="h-4 w-4 text-destructive" aria-hidden />
          )}
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
  const [caps, setCaps] = useState<OmniCapability[]>([...OMNI_CAPABILITIES]);
  const [reviewing, setReviewing] = useState(false);

  const refresh = useCallback(
    () =>
      load()
        .then((r) => {
          setS(r);
          setLoadError(null);
        })
        .catch((e: Error) => setLoadError(e.message)),
    [load],
  );
  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const active = s?.permits.filter((p) => p.status === "active") ?? [];
  const review = s ? authorizationReview(s, caps) : null;

  const confirmWithPasskey = async () => {
    setBusy(true);
    setMsg(null);
    try {
      // Re-read the live state right before the passkey so the owner confirms what is true now.
      const fresh = await load();
      setS(fresh);
      const check = authorizationReview(fresh, caps);
      if (!check.ready || !fresh.approval) {
        setMsg({
          ok: false,
          text: `Not sent for passkey: ${check.blockers.join("; ") || "no saved approval"}. Review the details again.`,
        });
        return;
      }
      const r = await stepUp(AUTONOMY_STEP_UP_ACTION, autonomyTarget(fresh.approval.approvalId), {
        apply: (grantId) => authorize({ data: { grantId, capabilities: caps } }),
        applyingText: "Passkey confirmed. Recording your permission…",
        doneText: () => "Done.",
      });
      if (!r.ok)
        setMsg({
          ok: false,
          text: `Not authorized: ${(r.reasons ?? []).map(permitReasonText).join("; ")}.`,
        });
      else {
        const blocked = r.executionBlockedBy ?? [];
        setReviewing(false);
        setMsg({
          ok: true,
          text: `${r.duplicate ? "Already authorized" : "Authorized"} until ${new Date(r.expiresAt!).toLocaleString()} for ${capText(r.capabilities ?? caps)}.${blocked.length ? ` OMNI still cannot run because ${blocked.map(permitReasonText).join(", ")}.` : ""}`,
        });
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  return (
    <section className="panel mb-4 space-y-3 p-4 text-sm" aria-labelledby="omni-autonomy">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="h-4 w-4 text-electric" aria-hidden />
        <h2 id="omni-autonomy" className="font-semibold">
          Jackboy permission for OMNI autonomous work
        </h2>
        <span className="text-xs text-muted-foreground">Owner only</span>
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          onClick={() => void refresh()}
        >
          <RefreshCw className="h-3 w-3" aria-hidden /> Recheck
        </button>
      </div>
      <p className="text-muted-foreground">
        Jackboy holds the key. OMNI may run an autonomous or CODE job only while it holds a Jackboy
        permit that lasts at most 60 seconds and must be renewed. Every renewal re-checks the Kill
        Switch, CODE Emergency Stop, CODE setting and spending protections. The bounded worker
        additionally requires an exact single-use plan and a continuously renewed one-second
        Mothership lease. A Step 10 approval never releases a stop, arms the worker or starts a job.
      </p>
      <UnifiedOmniStatus />

      {loadError && (
        <p className="text-xs text-destructive">
          Could not read the current state: {loadError}. Treat OMNI as blocked.
        </p>
      )}
      {s && (
        <>
          <p className="text-sm" data-testid="omni-autonomy-state">
            <span className="font-medium">Permit authority: {s.state.label}.</span>{" "}
            <span className="text-muted-foreground">{s.state.detail}</span>
          </p>
          <div
            className={`rounded-md border p-3 ${s.gates.omniCanRun ? "border-success/50" : "border-destructive/50"}`}
          >
            <p className="flex items-center gap-2 font-medium">
              {s.gates.omniCanRun ? (
                <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
              ) : (
                <OctagonX className="h-4 w-4 text-destructive" aria-hidden />
              )}
              {s.gates.omniCanRun
                ? "Owner and switch prerequisites pass; each permit still needs session, scope and budget checks"
                : "OMNI cannot run autonomous or CODE work right now"}
            </p>
            <div className="mt-2">
              <GateList gates={s.gates.run} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Change the Kill Switch, CODE setting and Emergency Stop in Settings → Activation.
              Nothing here changes them.
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium">Before you can authorize</p>
            <GateList gates={s.gates.authorize} />
          </div>

          {s.authorizationDetail ? (
            <div className="rounded-md border border-border p-3 text-xs">
              <p>
                Authorized {new Date(s.authorizationDetail.createdAt).toLocaleString()} until{" "}
                {new Date(s.authorizationDetail.expiresAt).toLocaleString()} (the end of the Step 7
                window).
              </p>
              <p>Allowed job kinds: {capText(s.authorizationDetail.capabilities)}.</p>
              <p className="text-muted-foreground">
                Saved on the server: it stays after a page refresh or restart until it expires or
                you revoke it. It never overrides the Kill Switch, Emergency Stop, CODE setting or
                spending limits.
              </p>
              <p className="text-muted-foreground">
                Limits: ${s.authorizationDetail.limits.dailyUsd.toFixed(2)} per day · $
                {s.authorizationDetail.limits.perCallUsd.toFixed(2)} per AI call · $
                {s.authorizationDetail.limits.perTaskUsd.toFixed(2)} reserved per job · one job at a
                time.
              </p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Not authorized. Limits that will apply: ${OMNI_AUTONOMY_LIMITS.dailyUsd.toFixed(2)}{" "}
              per day, ${OMNI_AUTONOMY_LIMITS.perCallUsd.toFixed(2)} per AI call, $
              {OMNI_AUTONOMY_LIMITS.perTaskUsd.toFixed(2)} reserved per job.
            </p>
          )}

          {!s.authorizationDetail && (
            <fieldset className="space-y-1 text-xs">
              <legend className="font-medium">Kinds of OMNI job to allow</legend>
              {OMNI_CAPABILITIES.map((c) => (
                <label key={c} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={caps.includes(c)}
                    disabled={busy || reviewing || s.scopeInstalled !== true}
                    onChange={(e) =>
                      setCaps((prev) =>
                        e.target.checked
                          ? OMNI_CAPABILITIES.filter((x) => x === c || prev.includes(x))
                          : prev.filter((x) => x !== c),
                      )
                    }
                  />
                  {OMNI_CAPABILITY_LABELS[c]}
                </label>
              ))}
              {s.scopeInstalled !== true && (
                <p className="text-muted-foreground">
                  {s.scopeInstalled === false
                    ? "Choosing only some kinds needs a database change that isn't installed yet, so both kinds apply."
                    : "Couldn't read the saved job kinds right now, so both kinds apply."}
                </p>
              )}
            </fieldset>
          )}

          {reviewing && review && !s.authorizationDetail && (
            <div
              className="space-y-3 rounded-md border border-electric/60 p-3"
              role="region"
              aria-labelledby="omni-autonomy-review"
              data-testid="omni-autonomy-review"
            >
              <p id="omni-autonomy-review" className="font-medium">
                Final review — check these details before confirming with your passkey
              </p>
              <ReviewSection title="Owner" rows={review.owner} />
              <ReviewSection title="OMNI project" rows={review.project} />
              <ReviewSection title="Allowed job kinds" rows={review.kinds} />
              <ReviewSection title="Current safety controls" rows={review.safety} />
              <p className="text-xs text-muted-foreground">
                {review.heldBy.length
                  ? `After you confirm, OMNI stays held because ${review.heldBy.join(" and ")}. Authorizing never changes the Kill Switch, Emergency Stop or CODE setting.`
                  : "After you confirm, OMNI could request a permit straight away. Authorizing never changes the Kill Switch, Emergency Stop or CODE setting."}{" "}
                Details checked {new Date(s.checkedAt).toLocaleTimeString()}; they are read again
                just before the passkey prompt opens.
              </p>
              {review.blockers.length > 0 && (
                <ul className="space-y-0.5 text-xs text-destructive" role="alert">
                  {review.blockers.map((b) => (
                    <li key={b}>Can't confirm yet: {b}.</li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-md border border-electric px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
                  disabled={busy || !review.ready}
                  onClick={() => void confirmWithPasskey()}
                >
                  <KeyRound className="h-4 w-4" aria-hidden /> Confirm with passkey
                </button>
                {review.stale && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
                    disabled={busy}
                    onClick={() => void refresh()}
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden /> Recheck details
                  </button>
                )}
                <button
                  type="button"
                  className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
                  disabled={busy}
                  onClick={() => setReviewing(false)}
                >
                  Back
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {!reviewing && !s.authorizationDetail && (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md border border-electric px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
                disabled={
                  busy ||
                  !s.gates.canAuthorize ||
                  !s.approval ||
                  caps.length === 0 ||
                  !canRecordScope(caps, s.scopeInstalled === true)
                }
                title={s.gates.canAuthorize ? undefined : "Every check above must pass first"}
                onClick={() => {
                  setMsg(null);
                  setReviewing(true);
                  void refresh();
                }}
              >
                <KeyRound className="h-4 w-4" aria-hidden /> Review before authorizing
              </button>
            )}
            {s.authorizationDetail && (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md border border-destructive px-3 py-1.5 text-xs text-destructive hover:bg-muted disabled:opacity-50"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setMsg(null);
                  try {
                    const r = await revoke();
                    setMsg({
                      ok: true,
                      text: `Revoked. ${r.revokedPermits} active permit(s) closed; OMNI must stop at its next check.`,
                    });
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
          {msg && (
            <p
              className={msg.ok ? "text-xs text-success" : "text-xs text-destructive"}
              role="status"
            >
              {msg.text}
            </p>
          )}

          <div className="space-y-1">
            <p className="text-xs font-medium">Permits ({active.length} active)</p>
            {s.permits.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {s.installed === true
                  ? "No permits issued yet."
                  : s.installed === false
                    ? "Permit service not installed yet."
                    : "Couldn't read permits right now."}
              </p>
            ) : (
              <ul className="space-y-1">
                {s.permits.map((p) => (
                  <li key={p.id} className="text-xs">
                    <span className="font-mono">{p.job_id.slice(0, 8)}</span> · {p.job_kind} ·{" "}
                    <span
                      className={p.status === "active" ? "text-success" : "text-muted-foreground"}
                    >
                      {p.status}
                    </span>{" "}
                    · issued {new Date(p.issued_at).toLocaleTimeString()}
                    {p.status === "active"
                      ? ` · until ${new Date(p.expires_at).toLocaleTimeString()} · renewed ${p.renewals}×`
                      : p.closed_reason
                        ? ` · ${permitReasonText(p.closed_reason)}`
                        : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium">Saved authorizations (newest first)</p>
            {!s.historyReadable ? (
              <p className="text-xs text-muted-foreground">Couldn't read the history right now.</p>
            ) : s.history.length === 0 ? (
              <p className="text-xs text-muted-foreground">None saved yet.</p>
            ) : (
              <ul className="space-y-1" data-testid="omni-autonomy-history">
                {s.history.map((h) => {
                  const state = h.revokedAt
                    ? `revoked ${new Date(h.revokedAt).toLocaleString()}${h.revokedReason ? ` (${h.revokedReason})` : ""}`
                    : Date.parse(h.expiresAt) <= Date.now()
                      ? `expired ${new Date(h.expiresAt).toLocaleString()}`
                      : `active until ${new Date(h.expiresAt).toLocaleString()}`;
                  return (
                    <li key={h.id} className="text-xs">
                      <span className="font-mono">{h.id.slice(0, 8)}</span> ·{" "}
                      {new Date(h.createdAt).toLocaleString()} · {capText(h.capabilities)} ·{" "}
                      <span
                        className={
                          !h.revokedAt && Date.parse(h.expiresAt) > Date.now()
                            ? "text-success"
                            : "text-muted-foreground"
                        }
                      >
                        {state}
                      </span>
                      {!h.byYou && " · by another account"}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium">Recent permission activity</p>
            {!s.auditReadable ? (
              <p className="text-xs text-muted-foreground">Couldn't read the activity list.</p>
            ) : s.audit.length === 0 ? (
              <p className="text-xs text-muted-foreground">No activity yet.</p>
            ) : (
              <ul className="space-y-1">
                {s.audit.map((a, i) => (
                  <li key={`${a.at}-${i}`} className="text-xs">
                    {new Date(a.at).toLocaleString()} · {AUDIT_LABELS[a.action] ?? a.action}
                    {a.capabilities ? ` · ${capText(a.capabilities)}` : ""}
                    {a.reasons.length ? ` · ${a.reasons.map(permitReasonText).join("; ")}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            Checked {new Date(s.checkedAt).toLocaleTimeString()}.
          </p>
        </>
      )}
    </section>
  );
}

import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, ShieldAlert, ShieldOff } from "lucide-react";
import { blockerNextStep } from "@/lib/omni-handoff-auth";
import { authorizeOmniProject, getOmniHandoffs, revokeOmniProject } from "@/lib/omni-handoff.functions";
import { probeOmniConnection } from "@/lib/omni-link.functions";
import { useStepUp } from "@/lib/step-up-client";
import { HANDOFF_KIND_LABEL, isHandoffKind, type HandoffKind } from "@/lib/omni-handoff-auth";
import { OmniDispatchReview } from "./OmniDispatchReview";

type Data = Awaited<ReturnType<typeof getOmniHandoffs>>;
const when = (iso: string) => new Date(iso).toLocaleString();

/** OMNI build/test handoffs: live link, per-project access (passkey to grant, one press to revoke)
 * and each queued job with the exact reasons it can or can't be handed off right now. */
export function OmniHandoffPanel() {
  const load = useServerFn(getOmniHandoffs);
  const authorize = useServerFn(authorizeOmniProject);
  const revoke = useServerFn(revokeOmniProject);
  const check = useServerFn(probeOmniConnection);
  const stepUp = useStepUp();
  const [d, setD] = useState<Data | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{ jobId: string; grantId: string } | null>(null);
  const [kinds, setKinds] = useState<Record<string, HandoffKind[]>>({});
  const [days, setDays] = useState(7);
  const checkConnection = () =>
    void act(async () => {
      const report = await check();
      return report.verified
        ? "Readiness checks pass and a session is recorded; live reachability is not tested. No job was sent."
        : `OMNI link readiness is blocked: ${report.missing.join(" · ")}. No job was sent.`;
    });

  const refresh = useCallback(
    () => load().then(setD).catch((e: Error) => setMsg({ tone: "err", text: e.message })),
    [load],
  );
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const act = async (work: () => Promise<string>) => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ tone: "ok", text: await work() });
    } catch (e) {
      setMsg({ tone: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const chosen = (projectId: string) => kinds[projectId] ?? ["code", "test"];
  const toggleKind = (projectId: string, k: HandoffKind) =>
    setKinds((s) => {
      const cur = s[projectId] ?? ["code", "test"];
      return { ...s, [projectId]: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k] };
    });

  return (
    <section className="panel mb-4 space-y-4 p-4 text-sm" aria-labelledby="omni-handoffs">
      <div className="flex flex-wrap items-center gap-2">
        {d?.link.live ? (
          <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
        ) : (
          <ShieldAlert className="h-4 w-4 text-warning" aria-hidden />
        )}
        <h2 id="omni-handoffs" className="font-semibold">
          Build &amp; test handoffs to OMNI
        </h2>
        <span className={`rounded border px-1.5 text-xs ${d?.link.live ? "border-success/50 text-success" : "border-warning/50 text-warning"}`}>
          {d ? (d.link.live ? "Legacy outbound link verified" : "Legacy outbound link not verified") : "Loading…"}
        </span>
        <button
          className="ml-auto rounded-md border border-border px-3 py-1.5 hover:bg-muted disabled:opacity-50"
          disabled={busy}
          onClick={checkConnection}
        >
          Verify latest link (read-only)
        </button>
      </div>
      <p className="text-muted-foreground">
        A job reaches OMNI only when all of these are true at that moment: OMNI's link was proven in the
        last 5 minutes, it's your own enrolled project, you've given OMNI access to that project for
        that kind of job, nothing has been revoked, and the Kill Switch is off. OMNI only receives
        the job; nothing runs, merges or deploys from here. The separate OMNI-initiated readiness check is read-only and does not enable this legacy outbound route.
      </p>
      {d?.link.config && !d.link.config.configured && <p className="text-xs text-warning">Connection configuration is incomplete. Missing secret names: {d.link.config.missing.join(", ") || "not reported"}; values are never displayed here.</p>}
      {d?.link.live && d.link.verifiedAt && d.link.expiresAt && <p className="text-xs text-muted-foreground">Last successful handshake: {when(d.link.verifiedAt)} · expires {when(d.link.expiresAt)}.</p>}
      {d?.expiredAuthorizations ? <p className="text-xs text-warning">Automatically expired and recorded {d.expiredAuthorizations} project authorization(s) and revoked {d.expiredJobApprovals} related job approval(s). Replacement still requires a fresh passkey.</p> : <p className="text-xs text-muted-foreground">Expired project access and job approvals are reconciled on refresh; replacement access always needs a fresh passkey.</p>}
      {d?.link.lastError && !d.link.live && <p className="text-xs text-warning">Last link check: {d.link.lastError}</p>}
      {d?.killSwitchOn && (
        <p role="alert" className="text-warning">The Kill Switch is on, so no handoff can be approved or sent.</p>
      )}

      <div>
        <h3 id="omni-project-access" className="text-xs font-semibold uppercase tracking-wider text-silver">Project access</h3>
        <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          New access lasts
          <select
            className="rounded border border-input bg-background px-1 py-0.5"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {[1, 7, 14, d?.maxDays ?? 30].map((n) => (
              <option key={n} value={n}>
                {n} day{n === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </label>
        <ul className="mt-2 divide-y divide-border">
          {d?.projects.map((p) => (
            <li key={p.id} id={`omni-project-${p.id}`} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{p.name}</span>
                {p.repo && <span className="ml-2 font-mono text-xs text-muted-foreground">{p.repo}</span>}
                {p.authorization ? (
                  <span className="block text-xs text-success">
                    OMNI may receive {p.authorization.kinds.map((k) => (isHandoffKind(k) ? HANDOFF_KIND_LABEL[k] : k)).join(" + ")} jobs until {when(p.authorization.expiresAt)}
                  </span>
                ) : (
                  <span className="block text-xs text-muted-foreground">{p.ineligibleReason ?? "OMNI has no access"}</span>
                )}
              </span>
              {p.authorization ? (
                <button
                  className="inline-flex items-center gap-1 rounded-md border border-destructive/40 px-3 py-1 text-destructive disabled:opacity-50"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      const r = await revoke({ data: { projectId: p.id } });
                      setReview(null);
                      return `OMNI's access to ${p.name} is revoked. ${r.revokedJobApprovals} job approval(s) were revoked with it.`;
                    })
                  }
                >
                  <ShieldOff className="h-3.5 w-3.5" aria-hidden />
                  Revoke access
                </button>
              ) : p.eligible ? (
                <span className="flex flex-wrap items-center gap-2">
                  {(["code", "test"] as const).map((k) => (
                    <label key={k} className="flex items-center gap-1 text-xs">
                      <input type="checkbox" checked={chosen(p.id).includes(k)} onChange={() => toggleKind(p.id, k)} />
                      {HANDOFF_KIND_LABEL[k]}
                    </label>
                  ))}
                  <button
                    className="rounded-md border border-border px-3 py-1 hover:bg-muted disabled:opacity-50"
                    disabled={busy || !d.link.live || d.killSwitchOn || chosen(p.id).length === 0}
                    title={!d.link.live ? "Check the connection first" : undefined}
                    onClick={() =>
                      void act(async () => {
                        const r = await stepUp("omni_project_scope", `omni-project:${p.id}`, {
                          apply: (grantId) => authorize({ data: { projectId: p.id, kinds: chosen(p.id), days, grantId } }),
                          applyingText: "Passkey confirmed. Giving OMNI access to this project…",
                          doneText: () => "OMNI access granted.",
                        });
                        return `OMNI may now receive ${r.kinds.map((k) => (isHandoffKind(k) ? HANDOFF_KIND_LABEL[k] : k)).join(" + ")} jobs for ${p.name} until ${when(r.expiresAt)}.`;
                      })
                    }
                  >
                    Give OMNI access with passkey
                  </button>
                </span>
              ) : null}
            </li>
          ))}
          {d && d.projects.length === 0 && <li className="py-2 text-muted-foreground">No registered projects yet.</li>}
        </ul>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-silver">Waiting build &amp; test jobs</h3>
        {d && d.handoffs.length === 0 && (
          <p className="mt-2 text-muted-foreground">No unsent build or test jobs. Queue one under Internal build tasks below.</p>
        )}
        <ul className="mt-2 space-y-2">
          {d?.handoffs.map((h) => (
            <li key={h.jobId} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {h.projectName} · {isHandoffKind(h.kind) ? HANDOFF_KIND_LABEL[h.kind] : h.kind}
                </span>
                {h.repo && <span className="font-mono text-xs text-muted-foreground">{h.repo}</span>}
                <span className={`ml-auto rounded border px-1.5 text-xs ${h.allowed ? "border-success/50 text-success" : "border-warning/50 text-warning"}`}>
                  {h.allowed ? (h.grant ? "Approved — ready to send" : "Ready to approve") : "Blocked"}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-xs">{h.instructions}</p>
              {h.blockers.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-warning">
                  {h.blockers.map((b) => {
                    const nextStep = blockerNextStep(b.code);
                    return <li key={b.code}>
                      {b.message}
                      {nextStep === "check_connection" && <button type="button" className="ml-2 underline" disabled={busy} onClick={checkConnection}>Verify latest link (read-only)</button>}
                      {nextStep === "project_access" && <a className="ml-2 underline" href={`#omni-project-${h.projectId ?? "access"}`}>Review project access</a>}
                      {nextStep === "review_project" && h.projectId && <a className="ml-2 underline" href={`/project/${encodeURIComponent(h.projectId)}`}>Review project</a>}
                      {nextStep === "review_settings" && <a className="ml-2 underline" href="/settings">Review Kill Switch in Settings</a>}
                    </li>;
                  })}
                </ul>
              )}
              {h.grant && <p className="mt-1 text-xs text-muted-foreground">Approval expires {when(h.grant.expiresAt)}</p>}
              <button
                className="mt-2 rounded-md border border-border px-3 py-1 text-xs hover:bg-muted disabled:opacity-50"
                disabled={!h.allowed}
                onClick={() => setReview({ jobId: h.jobId, grantId: h.grant?.id ?? "" })}
              >
                {h.grant ? "Open approved handoff" : "Review this job"}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {d && d.recentRevocations.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary>Recently revoked or expired access</summary>
          <ul className="mt-1 space-y-0.5">
            {d.recentRevocations.map((r) => (
              <li key={`${r.projectId}-${r.revokedAt}`}>
                {d.projects.find((p) => p.id === r.projectId)?.name ?? "Project"} · {r.reason} · {when(r.revokedAt)}
              </li>
            ))}
          </ul>
        </details>
      )}

      {msg && (
        <p role="status" className={msg.tone === "err" ? "text-destructive" : "text-success"}>
          {msg.text}
        </p>
      )}
      {review && <OmniDispatchReview key={`${review.jobId}:${review.grantId}`} initialJobId={review.jobId} initialGrantId={review.grantId} />}
    </section>
  );
}

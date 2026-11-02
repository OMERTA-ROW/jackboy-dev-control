import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { autoConnectAct, getAutoConnect } from "@/lib/autoconnect.functions";
import { bucket, capById, effectiveStatus, type Bucket, type CapStatus } from "@/lib/autoconnect";
import { approvalTarget, capRisk } from "@/lib/blockers";
import { useStepUp } from "@/lib/step-up-client";

export const Route = createFileRoute("/_authenticated/autoconnect")({
  head: () => ({
    meta: [
      { title: "AutoConnect — Jackboy" },
      { name: "description", content: "Approve and connect the tools each project needs, verified with real checks, then resume waiting work." },
      { property: "og:title", content: "AutoConnect — Jackboy" },
      { property: "og:description", content: "Per-project tool connections with real verification and automatic resume." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AutoConnect,
});

type D = Awaited<ReturnType<typeof getAutoConnect>>;
const btn = "rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50";
const primary = "rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50";
const BUCKETS: Bucket[] = ["Connected", "Needs Approval", "Missing/Blocked"];

function AutoConnect() {
  const stepUp = useStepUp();
  const get = useServerFn(getAutoConnect), act = useServerFn(autoConnectAct);
  const [d, setD] = useState<D | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => get().then(setD).catch((e) => setMsg((e as Error).message)), [get]);
  useEffect(() => { void load(); }, [load]);
  const run = async (key: string, cap: string, projectId: string, op: "approve" | "verify" | "pause" | "resume" | "revoke") => {
    setBusy(key); setMsg(null);
    try {
      const grantId = op === "approve" && capRisk(cap) === "Critical" ? await stepUp("approve_integration", approvalTarget(cap, projectId)) : undefined;
      const r = await act({ data: { cap, projectId, op, grantId } }) as { status?: string; detail?: string; resumed?: number };
      if (op === "verify") setMsg(`${r.status === "connected" ? "Connected" : "Not connected"}: ${r.detail}${r.resumed ? ` · resumed ${r.resumed} waiting task(s)` : ""}`);
      if (op === "approve") { setMsg(r.status === "connected" ? `Connected. ${r.resumed ?? 0} waiting task(s) resumed.` : `Approved, but not connected: ${r.detail ?? "Finish provider setup and press Verify now."}`); setOpen(key); }
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(null); void load(); }
  };
  if (!d) return <><PageHeader title="AutoConnect" subtitle="Checking what each project needs…" />{msg && <p className="text-destructive">{msg}</p>}</>;
  const names = Object.fromEntries(d.projects.map((p) => [p.id, p.name]));
  const rows = d.grants.map((g) => ({ ...g, eff: effectiveStatus({ status: g.status as CapStatus, expires_at: g.expires_at }) }));
  const healthOk = rows.filter((r) => r.eff === "connected").length;

  return (
    <>
      <PageHeader title="AutoConnect" subtitle="Approving a tool never grants access by itself. You finish setup with the provider, Jackboy checks it with a real call, then resumes waiting work." />
      {msg && <p role="status" className="mb-4 text-sm text-warning">{msg}</p>}
      <section className="panel mb-4 grid grid-cols-2 gap-3 p-4 md:grid-cols-4" aria-label="Summary">
        {BUCKETS.map((b) => <div key={b}><p className="text-xs uppercase text-muted-foreground">{b}</p><p className="text-2xl font-semibold">{rows.filter((r) => bucket(r.eff) === b).length}</p></div>)}
        <div><p className="text-xs uppercase text-muted-foreground">Health</p><p className="text-sm">{healthOk} verified · {d.waiting.length} task(s) waiting on a tool</p></div>
      </section>
      {BUCKETS.map((b) => {
        const list = rows.filter((r) => bucket(r.eff) === b);
        if (!list.length) return null;
        return (
          <section key={b} className="mb-6">
            <h2 className="mb-2 text-lg font-semibold">{b}</h2>
            <ul className="space-y-3">{list.map((g) => {
              const c = capById(g.capability); const key = `${g.capability}:${g.project_id}`;
              const waiting = d.waiting.filter((t) => t.project_id === g.project_id && t.needs_capability === g.capability);
              return (
                <li key={g.id} className="panel p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div><p className="font-medium">{c?.name ?? g.capability}</p><p className="text-xs text-muted-foreground">{names[g.project_id] ?? "project"} · {g.account ? `account ${g.account} · ` : ""}{g.last_verified_at ? `checked ${new Date(g.last_verified_at).toLocaleString()}` : "never checked"}{g.paused ? " · paused" : ""}</p></div>
                    <span className={`text-xs font-semibold uppercase ${g.eff === "connected" ? "text-success" : g.eff === "error" || g.eff === "revoked" ? "text-destructive" : "text-warning"}`}>{g.eff.replace("_", " ")}</span>
                  </div>
                  <p className="mt-2 text-xs"><span className="font-semibold">How:</span> {c?.method} · <span className="font-semibold">Exact permission:</span> {c?.scopes} · <span className="font-semibold">Expires:</span> {g.expires_at ? new Date(g.expires_at).toLocaleDateString() : "set by the provider token"}</p>
                  {g.last_error && <p className="mt-1 text-xs text-warning">{g.last_error}</p>}
                  {waiting.length > 0 && <p className="mt-1 text-xs">Waiting on this: {waiting.map((w) => w.title).join(", ")}</p>}
                  {(open === key || g.eff === "awaiting_setup" || g.eff === "error") && c?.verifiable && (
                    <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">{c.steps.map((s) => <li key={s}>{s}</li>)}
                      {c.setupUrl && <li><a className="text-primary underline" href={c.setupUrl} target="_blank" rel="noreferrer">Open provider setup</a></li>}</ol>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(g.eff === "needs_approval" || g.eff === "missing" || g.eff === "revoked" || g.eff === "expired") && c?.verifiable && <button className={primary} disabled={!!busy} onClick={() => run(key, g.capability, g.project_id, "approve")}>{capRisk(g.capability) === "Critical" ? "Approve with passkey & check" : "Approve & check"}</button>}
                    {(g.eff === "awaiting_setup" || g.eff === "error" || g.eff === "connected") && <button className={btn} disabled={!!busy || g.paused} onClick={() => run(key, g.capability, g.project_id, "verify")}>{busy === key ? "Checking…" : "Verify now"}</button>}
                    {g.eff !== "unavailable" && g.eff !== "revoked" && <button className={btn} disabled={!!busy} onClick={() => run(key, g.capability, g.project_id, g.paused ? "resume" : "pause")}>{g.paused ? "Resume" : "Pause"}</button>}
                    {(g.eff === "connected" || g.eff === "awaiting_setup") && <button className={btn} disabled={!!busy} onClick={() => run(key, g.capability, g.project_id, "revoke")}>Revoke</button>}
                    {!c?.verifiable && <span className="text-xs text-muted-foreground">{c?.steps[0]}</span>}
                  </div>
                </li>
              );
            })}</ul>
          </section>
        );
      })}
    </>
  );
}


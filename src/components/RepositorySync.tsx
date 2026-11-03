import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, Link } from "@tanstack/react-router";
import { approvalBlocker } from "@/lib/repository-resync";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { checkRepositorySync, approveRepositorySync, type ResyncReview } from "@/lib/repository-resync.functions";
import { useStepUp } from "@/lib/step-up-client";
import { RESYNC_INTERVAL_MS } from "@/lib/repository-resync";
import { Button } from "@/components/ui/button";

type SyncState = { review: ResyncReview | null; busy: boolean; error: string; run: (force?: boolean) => Promise<void> };
const SyncContext = createContext<SyncState | null>(null);
export function RepositorySyncProvider({ children }: { children: ReactNode }) {
  const check = useServerFn(checkRepositorySync);
  const queryClient = useQueryClient();
  const [review, setReview] = useState<ResyncReview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const running = useRef(false);
  const run = useCallback(async (force = false) => {
    if (running.current) { if (force) setError("A check is already running — results will appear when it finishes."); return; }
    const { data } = await supabase.auth.getUser();
    if (!data.user) { setReview(null); return; }
    const { data: role } = await supabase.rpc("my_role");
    if (role !== "owner") { if (force) setError("Only the owner can resync repositories."); return; }
    running.current = true; setBusy(true); setError("");
    try {
      const next = await check({ data: { force } });
      setReview(next);
      await queryClient.invalidateQueries({ queryKey: ["project-hub"] });
    }
    catch (e) { setError(e instanceof Error ? e.message : "Repository verification failed"); }
    finally { running.current = false; setBusy(false); }
  }, [check, queryClient]);
  useEffect(() => {
    void run();
    const timer = window.setInterval(() => void run(), RESYNC_INTERVAL_MS);
    // Poll invalidation metadata; the server caches evidence for 15 minutes, with bounded failure retries.
    const failures = window.setInterval(() => void run(), 60_000);
    const focus = () => void run();
    window.addEventListener("focus", focus);
    const { data: auth } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") { setReview(null); setError(""); }
      if (event === "SIGNED_IN") void run();
    });
    return () => { auth.subscription.unsubscribe(); window.clearInterval(timer); window.clearInterval(failures); window.removeEventListener("focus", focus); };
  }, [run]);
  return <SyncContext.Provider value={{ review, busy, error, run }}>{children}</SyncContext.Provider>;
}
export function ConnectedProjectsResync() {
  const sync = useContext(SyncContext);
  if (!sync) return null;
  return <div className="my-3 flex flex-wrap items-center gap-3"><Button variant="outline" disabled={sync.busy} onClick={() => void sync.run(true)}><RefreshCw />{sync.busy ? "Resyncing…" : "Resync"}</Button><Button asChild variant="link"><Link to="/settings" hash="repository-sync">Review proposed changes</Link></Button><span className="text-xs text-muted-foreground">Last synced: {sync.review ? new Date(sync.review.created_at).toLocaleString() : "Not yet checked"}</span>{sync.error && <p role="alert" className="w-full text-sm text-destructive">{sync.error}</p>}</div>;
}
export function RepositorySyncPanel() {
  const sync = useContext(SyncContext);
  const approve = useServerFn(approveRepositorySync), stepUp = useStepUp();
  const queryClient = useQueryClient(), router = useRouter();
  const [approving, setApproving] = useState(false), [error, setError] = useState(""), [result, setResult] = useState("");
  if (!sync) return null;
  const { review, busy } = sync;
  const rows = review?.report.rows ?? [];
  const changes = rows.filter((r) => r.canApply && r.group !== "linked");
  const blocker = approvalBlocker({ changes: changes.length, busy, invalidated: !!review?.invalidated, approved: !!review?.approved_at });
  const apply = async () => {
    if (!review) return;
    if (blocker) { setError(blocker); return; }
    setApproving(true); setError(""); setResult("");
    try {
      const grantId = await stepUp("approve_integration", `repository_resync:${review.id}`);
      const out = await approve({ data: { reviewId: review.id, grantId } }) as { alreadyApplied?: boolean } | null;
      setResult(out?.alreadyApplied ? "These changes were already applied." : `Applied ${changes.length} change${changes.length === 1 ? "" : "s"}: ${changes.map((c) => c.group === "deleted" ? `unlinked ${c.repo}` : `${c.profiles?.[0]?.oldName ?? c.repo} → ${c.proposed}`).join("; ")}. History kept; changed projects need reconnecting.`);
      await queryClient.invalidateQueries(); await router.invalidate(); await sync.run(true);
    } catch (e) { setError(e instanceof Error ? e.message : "Approval failed; no changes applied"); }
    finally { setApproving(false); }
  };
  return <section aria-labelledby="repository-sync" className="mb-6 border-b border-border pb-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="repository-sync" className="font-semibold">Repository review</h2>
      <Button variant="outline" disabled={busy || approving} onClick={() => void sync.run(true)}><RefreshCw className={busy ? "animate-spin" : ""} />Resync repositories</Button>
    </div>
    <p className="mt-2 text-sm text-muted-foreground">Last synced: {review ? new Date(review.created_at).toLocaleString() : "Not yet checked"}{busy ? " · Checking GitHub…" : ""}</p>
    {(sync.error || error) && <p role="alert" className="mt-2 break-words text-sm text-destructive">{error || sync.error}</p>}
    {result && <p role="status" className="mt-2 text-sm text-success">{result}</p>}
    {review && <>
      <p className="mt-3 text-sm"><strong>GITHUB_TOKEN: {review.report.tokenState === "missing" ? "No GITHUB_TOKEN set" : review.report.login}</strong> · {review.report.inventoryCount} accessible repositories (token + GitHub App)</p>
      <ul className="mt-2 text-xs text-muted-foreground">{Object.entries(review.report.permissions).map(([key, value]) => <li key={key}>{key.replace("_", " ")}: {value}</li>)}</ul>
      {review.report.warning && <p role="alert" className="mt-2 text-sm text-destructive">{review.report.warning}</p>}
      <p className="mt-2 text-xs text-muted-foreground">Repos are checked with the GitHub App installation when it covers them, otherwise with GITHUB_TOKEN. Token values are never shown.</p>
      {([['linked', 'Linked OK'], ['missing', 'Missing link — proposed match'], ['moved', 'Moved — proposed new match'], ['deleted', 'Deleted — proposed removal']] as const).map(([group, title]) => <div key={group} className="mt-4">
        <h3 className="text-sm font-semibold">{title} ({rows.filter((r) => r.group === group).length})</h3>
        <ul className="divide-y divide-border">{rows.filter((r) => r.group === group).map((r) => <li key={r.repo} className="py-3 text-sm [overflow-wrap:anywhere]">
          <strong>{r.group === "missing" ? r.profiles?.[0]?.oldName ?? "Unlinked project" : r.repo}</strong>{r.group === "missing" && !r.proposed ? <span className="text-muted-foreground"> · No repo linked</span> : r.group !== "linked" && <span> → {r.proposed ?? (r.canApply ? "Remove saved link" : "No change available")}</span>}
          {r.profiles?.map((p) => <p key={p.projectId} className="text-xs text-muted-foreground">Display name: {p.oldName} → {p.newName}; current profile and matching inventory names update together. History remains unchanged.</p>)}
          <p className={r.group === "linked" || (r.group === "missing" && !r.canApply) ? "text-muted-foreground text-xs" : r.group === "deleted" ? "text-destructive text-xs" : "text-xs"}>{r.reason}</p>
          <p className="text-xs text-muted-foreground">{r.mutable} current references · {r.historical} historical references preserved{!r.canApply && r.group !== "linked" ? " · Not included in approval" : ""}</p>
        </li>)}</ul>
      </div>)}
      <Button className="mt-4" disabled={approving} aria-describedby="approve-why" onClick={() => void apply()}><ShieldCheck />{approving ? "Confirming with your passkey…" : `Approve ${changes.length} change${changes.length === 1 ? "" : "s"} together`}</Button>
      {blocker && <p id="approve-why" className="mt-2 text-xs text-muted-foreground">{blocker}</p>}
    </>}
  </section>;
}
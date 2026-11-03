import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, Link } from "@tanstack/react-router";
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
  const [review, setReview] = useState<ResyncReview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const running = useRef(false);
  const run = useCallback(async (force = false) => {
    if (running.current) return;
    const { data } = await supabase.auth.getUser();
    if (!data.user) { setReview(null); return; }
    const { data: role } = await supabase.rpc("my_role");
    if (role !== "owner") return;
    running.current = true; setBusy(true); setError("");
    try { setReview(await check({ data: { force } })); }
    catch (e) { setError(e instanceof Error ? e.message : "Repository verification failed"); }
    finally { running.current = false; setBusy(false); }
  }, [check]);
  useEffect(() => {
    void run();
    const timer = window.setInterval(() => void run(), RESYNC_INTERVAL_MS);
    // Poll invalidation metadata; the server caches evidence for 15 minutes, with bounded failure retries.
    const failures = window.setInterval(() => void run(), 60_000);
    const focus = () => void run();
    window.addEventListener("focus", focus);
    return () => { window.clearInterval(timer); window.clearInterval(failures); window.removeEventListener("focus", focus); };
  }, [run]);
  return <SyncContext.Provider value={{ review, busy, error, run }}>{children}</SyncContext.Provider>;
}
export function RepositorySyncAlert() {
  const sync = useContext(SyncContext);
  if (!sync || !sync.review?.report.rows.some((r) => r.group !== "linked" && r.mutable > 0)) return null;
  return <div role="alert" className="flex flex-wrap items-center gap-3 border-b border-border bg-muted px-4 py-3 text-sm md:px-8">
    <span className="text-destructive">Repos out of sync — review</span>
    <Button size="sm" variant="outline" disabled={sync.busy} onClick={() => void sync.run(true)}><RefreshCw />Resync repositories</Button>
    <Button asChild size="sm" variant="link"><Link to="/settings">Review changes</Link></Button>
  </div>;
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
  const apply = async () => {
    if (!review) return;
    setApproving(true); setError(""); setResult("");
    try {
      const grantId = await stepUp("approve_integration", `repository_resync:${review.id}`);
      await approve({ data: { reviewId: review.id, grantId } });
      setResult(`${changes.length} repository changes applied together. Project records and history preserved; changed targets require reconnection.`);
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
      <p className="mt-3 text-sm"><strong>GITHUB_TOKEN · {review.report.login}</strong> · {review.report.inventoryCount} accessible repositories</p>
      <ul className="mt-2 text-xs text-muted-foreground">{Object.entries(review.report.permissions).map(([key, value]) => <li key={key}>{key.replace("_", " ")}: {value}</li>)}</ul>
      {review.report.warning && <p role="alert" className="mt-2 text-sm text-destructive">{review.report.warning}</p>}
      <p className="mt-2 text-xs text-muted-foreground">This review uses GITHUB_TOKEN only; existing organization work still uses the GitHub App. Not found does not prove deletion.</p>
      {([['linked', 'Linked OK'], ['moved', 'Moved — proposed new match'], ['deleted', 'Deleted — proposed removal']] as const).map(([group, title]) => <div key={group} className="mt-4">
        <h3 className="text-sm font-semibold">{title} ({rows.filter((r) => r.group === group).length})</h3>
        <ul className="divide-y divide-border">{rows.filter((r) => r.group === group).map((r) => <li key={r.repo} className="py-3 text-sm [overflow-wrap:anywhere]">
          <strong>{r.repo}</strong>{r.group !== "linked" && <span> → {r.proposed ?? (r.canApply ? "Remove saved link" : "No change available")}</span>}
          <p className={r.group === "linked" ? "text-muted-foreground text-xs" : "text-destructive text-xs"}>{r.reason}</p>
          <p className="text-xs text-muted-foreground">{r.mutable} current references · {r.historical} historical references preserved{!r.canApply && r.group !== "linked" ? " · Not included in approval" : ""}</p>
        </li>)}</ul>
      </div>)}
      <Button className="mt-4" disabled={!changes.length || busy || approving || review.invalidated || !!review.approved_at} onClick={() => void apply()}><ShieldCheck />{approving ? "Confirming…" : `Approve ${changes.length} changes together`}</Button>
    </>}
  </section>;
}
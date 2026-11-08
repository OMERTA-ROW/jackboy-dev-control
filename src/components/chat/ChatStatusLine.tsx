// One compact, read-only status line: Kill Switch, CODE, waiting approvals, failures, CI for the project.
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { getChatDigest } from "@/lib/chat-threads.functions";
import { getGitHubPrepStatus } from "@/lib/github-prep.functions";
import { ciLabel } from "@/lib/github-prep";

type Digest = Awaited<ReturnType<typeof getChatDigest>>;
type Ci = Awaited<ReturnType<typeof getGitHubPrepStatus>>;
const chip = "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border px-2 py-0.5 hover:border-silver";
const dot = (tone: "ok" | "warn" | "bad" | "muted") => <span aria-hidden className={`size-1.5 rounded-full ${tone === "ok" ? "bg-success" : tone === "warn" ? "bg-warning" : tone === "bad" ? "bg-destructive" : "bg-muted-foreground"}`} />;

export function ChatStatusLine({ projectId, hasRepo }: { projectId: string | null; hasRepo: boolean }) {
  const digestFn = useServerFn(getChatDigest);
  const ciFn = useServerFn(getGitHubPrepStatus);
  const [d, setD] = useState<Digest | null>(null);
  const [err, setErr] = useState(false);
  const [ci, setCi] = useState<Ci | null>(null);
  const load = useCallback(() => digestFn().then((x) => { setD(x); setErr(false); }).catch(() => setErr(true)), [digestFn]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    const f = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", f);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", f); };
  }, [load]);
  useEffect(() => {
    setCi(null);
    if (!projectId || !hasRepo) return;
    let alive = true;
    ciFn({ data: { projectId } }).then((c) => { if (alive) setCi(c); }).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId, hasRepo, ciFn]);

  if (err && !d) return <p className="px-4 pb-1 text-[11px] text-muted-foreground">Status unavailable right now.</p>;
  if (!d) return null;
  const s = d.safety, w = d.waiting, f = d.failures;
  const failedPr = ci?.pulls.filter((p) => p.ci.state === "failed").length ?? 0;
  return (
    <div role="status" aria-label="Status" className="no-scrollbar flex gap-1.5 overflow-x-auto px-3 pb-2 text-[11px] text-muted-foreground sm:px-6">
      <Link to="/settings" hash="activation" className={chip}>{s ? dot(s.killSwitch ? "warn" : "ok") : dot("muted")}Kill Switch {s ? (s.killSwitch ? "on" : "off") : "?"}</Link>
      <Link to="/settings" hash="activation" className={chip}>{s ? dot(s.codeEnabled ? "ok" : "muted") : dot("muted")}CODE {s ? (s.codeEnabled ? "on" : "off") : "?"}</Link>
      <Link to="/updates" className={chip}>{w ? dot(w.count ? "warn" : "ok") : dot("muted")}{w ? `${w.count} waiting${w.complete ? "" : " (partial)"}` : "Approvals ?"}</Link>
      <Link to="/site-log" className={chip}>{f ? dot(f.count ? "bad" : "ok") : dot("muted")}{f ? `${f.count} failure${f.count === 1 ? "" : "s"} today` : "Log ?"}</Link>
      {typeof d.unread === "number" && d.unread > 0 && <Link to="/reports" className={chip}>{dot("warn")}{d.unread} unread</Link>}
      {ci && projectId && <Link to="/project/$id" params={{ id: projectId }} className={chip}>{dot(ci.error ? "muted" : ci.baseCi?.state === "failed" || failedPr ? "bad" : ci.baseCi?.state === "passed" ? "ok" : "warn")}
        {ci.error ? "CI unavailable" : `CI ${ci.base}: ${ci.baseCi ? ciLabel(ci.baseCi.state).toLowerCase() : "unknown"} · ${ci.pulls.length} open PR${ci.pulls.length === 1 ? "" : "s"}${failedPr ? `, ${failedPr} failing` : ""}`}</Link>}
    </div>
  );
}

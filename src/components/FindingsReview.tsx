import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { btn } from "@/components/ProjectBits";
import { actOnFinding, getDecisions, setProjectPrefs, undoDecision, type Decision, type HubScanRow } from "@/lib/project-hub.functions";
import { findingKey } from "@/lib/autopilot";

const SEV: Record<string, string> = { high: "text-destructive", medium: "text-warning", low: "text-muted-foreground" };
const DONE: Record<Decision["decision"], string> = { ignored: "Ignored", remove_demo: "Demo removal waiting for approval", repair: "Repair written" };

export const STEPS = ["Select project", "Scan", "Review", "Repair", "Verify"] as const;
export function Steps({ at }: { at: number }) {
  return (
    <ol aria-label="Workflow" className="mb-5 flex flex-wrap gap-2 text-xs">
      {STEPS.map((s, i) => (
        <li key={s} aria-current={i === at ? "step" : undefined} className={`rounded-full border px-3 py-1 ${i < at ? "border-success/40 text-success" : i === at ? "border-electric text-electric" : "border-border text-muted-foreground"}`}>{i + 1}. {s}</li>
      ))}
    </ol>
  );
}

export function FindingsReview({ projectId, scan, onChanged }: { projectId: string; scan: HubScanRow; onChanged: () => void }) {
  const load = useServerFn(getDecisions), act = useServerFn(actOnFinding), undo = useServerFn(undoDecision), prefs = useServerFn(setProjectPrefs);
  const [d, setD] = useState<Awaited<ReturnType<typeof getDecisions>> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const [showIgnored, setShowIgnored] = useState(false);
  const refresh = useCallback(() => load({ data: { id: projectId } }).then(setD).catch((e) => setErr((e as Error).message)), [load, projectId]);
  useEffect(() => { void refresh(); }, [refresh, scan.id]);
  const byKey = new Map((d?.decisions ?? []).map((x) => [x.finding_key, x]));
  const rows = scan.findings.map((f, i) => ({ f, i, key: findingKey(f), dec: byKey.get(findingKey(f)) }));
  const visible = rows.filter((r) => showIgnored || r.dec?.decision !== "ignored");
  const demo = visible.filter((r) => r.f.kind === "demo"), other = visible.filter((r) => r.f.kind !== "demo");
  const ignoredCount = rows.filter((r) => r.dec?.decision === "ignored").length;

  const run = async (k: string, fn: () => Promise<string>) => {
    setBusy(k); setErr(""); setMsg("");
    try { setMsg(await fn()); await refresh(); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const Row = ({ r }: { r: (typeof rows)[number] }) => (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 text-sm">
        <span className={`mr-2 text-xs uppercase ${SEV[r.f.severity] ?? ""}`}>{r.f.severity}</span>{r.f.message}
        <div className="truncate text-xs text-muted-foreground">{r.f.url}</div>
      </div>
      {r.dec ? (
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {DONE[r.dec.decision]}
          {r.dec.decision === "ignored" ? <button className={btn} disabled={busy !== null} onClick={() => run(r.key, async () => { await undo({ data: { projectId, key: r.key } }); return "Undone."; })}>Undo</button>
            : <Link to="/updates" className="text-electric underline">Review</Link>}
        </div>
      ) : (
        <div className="flex shrink-0 flex-wrap gap-2">
          {r.f.kind === "demo" && <button className={btn} disabled={busy !== null} onClick={() => run(r.key, async () => (await act({ data: { scanId: scan.id, index: r.i, action: "remove_demo" } })).note)}>{busy === r.key ? "Writing…" : "Remove Demo"}</button>}
          <button className={btn} disabled={busy !== null} onClick={() => run(r.key, async () => (await act({ data: { scanId: scan.id, index: r.i, action: "repair" } })).note)}>Repair</button>
          <button className={btn} disabled={busy !== null} onClick={() => run(r.key, async () => (await act({ data: { scanId: scan.id, index: r.i, action: "ignored" } })).note)}>Ignore</button>
        </div>
      )}
    </li>
  );

  return (
    <div className="mt-3">
      {err && <p role="alert" className="mb-2 text-sm text-destructive">{err}</p>}
      {msg && <p aria-live="polite" className="mb-2 text-sm">{msg}</p>}
      <h3 className="text-sm font-semibold">Demo &amp; placeholder items ({demo.length})</h3>
      <p className="text-xs text-muted-foreground">Text that looks like demo UI. It may be real — check before removing. Removal is always sent to your approval queue as a reversible change; nothing is deleted from the live site directly.</p>
      {demo.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">None found.</p> : <ul className="divide-y divide-border">{demo.map((r) => <Row key={r.i} r={r} />)}</ul>}
      <h3 className="mt-4 text-sm font-semibold">Errors &amp; other issues ({other.length})</h3>
      {other.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">None found.</p> : <ul className="divide-y divide-border">{other.map((r) => <Row key={r.i} r={r} />)}</ul>}
      {ignoredCount > 0 && <button className="mt-2 text-xs text-electric underline" onClick={() => setShowIgnored((v) => !v)}>{showIgnored ? "Hide" : "Show"} {ignoredCount} ignored</button>}
      {d && (
        <fieldset className="mt-4 rounded-md border border-border p-3 text-sm">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-silver">Automation for this project</legend>
          <label className="flex items-center gap-2"><input type="checkbox" checked={d.demoDetection} disabled={busy !== null} onChange={(e) => run("prefs", async () => { await prefs({ data: { id: projectId, demo_detection: e.target.checked, repair_policy: d.repairPolicy } }); return "Saved. Applies to the next scan."; })} /> Look for demo/placeholder items when scanning</label>
          <label className="mt-2 flex flex-wrap items-center gap-2">Repairs:
            <select value={d.repairPolicy} disabled={busy !== null} onChange={(e) => run("prefs", async () => { await prefs({ data: { id: projectId, demo_detection: d.demoDetection, repair_policy: e.target.value as "autopilot" | "approve" } }); return "Saved."; })} className="rounded border border-border bg-background px-2 py-1 text-xs">
              <option value="autopilot">Follow Autopilot (ship safe fixes after checks pass)</option>
              <option value="approve">Always ask me first</option>
            </select>
          </label>
          <p className="mt-1 text-xs text-muted-foreground">Demo removals, sensitive files and deployments always wait for your approval.</p>
        </fieldset>
      )}
    </div>
  );
}

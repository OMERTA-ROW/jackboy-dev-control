import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { getQualityMetrics } from "@/lib/foundry.functions";
import type { QualityMetrics as Q, Rate } from "@/lib/quality-metrics";

const ROWS: [keyof Omit<Q, "testsNotRunnable">, string, boolean][] = [
  ["repairSuccess", "Repair success", true], ["testFailure", "Test failures", false], ["regression", "Regressions", false],
  ["failedDeployment", "Failed installs", false], ["rollback", "Rollbacks", false],
];

export function QualityMetrics() {
  const get = useServerFn(getQualityMetrics);
  const [m, setM] = useState<Q | null>(null); const [err, setErr] = useState("");
  useEffect(() => { get().then(setM).catch((e) => setErr((e as Error).message)); }, [get]);
  if (err) return <p role="alert" className="text-sm text-destructive">{err}</p>;
  if (!m) return <p className="text-sm text-muted-foreground">Loading quality metrics…</p>;
  return (
    <section aria-labelledby="quality" className="mb-6">
      <h2 id="quality" className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Quality metrics</h2>
      <ul className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {ROWS.map(([k, label, goodHigh]) => { const r = m[k] as Rate; const bad = r.value !== null && (goodHigh ? r.value < 50 : r.value > 0);
          return (
            <li key={k} className="panel p-3" title={r.note}>
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className={`text-2xl font-semibold ${r.value === null ? "text-muted-foreground" : bad ? "text-destructive" : "text-success"}`}>{r.value === null ? "—" : `${r.value}%`}</p>
              <p className="text-xs text-muted-foreground">{r.den ? `${r.num} of ${r.den}` : "Not enough data"}</p>
            </li>); })}
      </ul>
      {m.testsNotRunnable > 0 && <p className="mt-2 text-xs text-warning">{m.testsNotRunnable} repair(s) had no test results: GitHub Actions read permission is missing.</p>}
    </section>
  );
}

import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getOmniV3Results } from "@/lib/omni-v3-results.functions";

type Results = Awaited<ReturnType<typeof getOmniV3Results>>;

export function OmniV3Results() {
  const load = useServerFn(getOmniV3Results);
  const [results, setResults] = useState<Results | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setResults(await load());
    } catch {
      setError("OMNI results could not be loaded.");
    } finally {
      setBusy(false);
    }
  }, [load]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section
      className="space-y-2 rounded border border-border p-3"
      aria-labelledby="omni-v3-results"
    >
      <div className="flex items-center gap-2">
        <h2 id="omni-v3-results" className="font-semibold">
          OMNI v3 results
        </h2>
        <button
          type="button"
          className="ml-auto rounded border border-border px-3 py-1 hover:bg-muted disabled:opacity-50"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Read-only; the latest 20 records for your account.
      </p>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {!results && !error && <p>Loading…</p>}
      {results?.length === 0 && <p>No v3 dispatch records yet.</p>}
      {results && results.length > 0 && (
        <ul className="divide-y divide-border">
          {results.map((job) => (
            <li key={job.jobId} className="space-y-1 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{job.jobId}</span>
                <span className="rounded border border-border px-1.5 text-xs">
                  {job.status.replaceAll("_", " ")}
                </span>
                <span>
                  {job.kind} · {job.repo}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Created {new Date(job.createdAt).toLocaleString()} · updated{" "}
                {new Date(job.updatedAt).toLocaleString()} · expires{" "}
                {new Date(job.expiresAt).toLocaleString()}
              </p>
              {job.result && (
                <>
                  {job.result.passed !== null && <p>{job.result.passed ? "Passed" : "Failed"}</p>}
                  {Object.entries(job.result.testCounts).some(([, value]) => value !== null) && (
                    <p className="text-xs">
                      Tests:{" "}
                      {Object.entries(job.result.testCounts)
                        .filter(([, value]) => value !== null)
                        .map(([key, value]) => `${key} ${value}`)
                        .join(" · ")}
                    </p>
                  )}
                  {job.result.summary && <p className="break-words">{job.result.summary}</p>}
                  {job.result.log && (
                    <pre className="overflow-auto whitespace-pre-wrap break-words text-xs">
                      {job.result.log}
                    </pre>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

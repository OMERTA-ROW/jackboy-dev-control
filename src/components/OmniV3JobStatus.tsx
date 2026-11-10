// Shows the stored v3 OMNI job status and result exactly as recorded; a missing result is said plainly.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getOmniV3Job } from "@/lib/omni-link.functions";
import { Button } from "@/components/ui/button";

export type V3JobView = Awaited<ReturnType<typeof getOmniV3Job>>;

const TERMINAL = new Set(["completed", "failed", "cancelled", "expired"]);

export function V3JobDetails({ view }: { view: V3JobView }) {
  if (!view.ok)
    return (
      <p role="alert" className="text-destructive">
        {view.error}
      </p>
    );
  return (
    <div className="space-y-1">
      <p>
        Job <code className="break-all">{view.jobId}</code>
        {view.repo && (
          <>
            {" "}
            · <code>{view.repo}</code>
          </>
        )}
      </p>
      <p>
        Status:{" "}
        <strong
          className={
            view.status === "completed"
              ? "text-success"
              : view.status === "failed" || view.status === "expired"
                ? "text-destructive"
                : "text-warning"
          }
        >
          {view.status ?? "nothing reported yet"}
        </strong>
        {view.updatedAt && (
          <span className="text-muted-foreground">
            {" "}
            · updated {new Date(view.updatedAt).toLocaleString()}
            {view.source ? ` (from ${view.source === "callback" ? "OMNI's callback" : "OMNI's reply"})` : ""}
          </span>
        )}
      </p>
      {view.outcome && (
        <p className={view.outcome === "passed" ? "text-success" : "text-destructive"}>
          Tests {view.outcome}
        </p>
      )}
      {view.summary !== null && <p>OMNI says: {view.summary || "(empty summary)"}</p>}
      {view.output !== null && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-[11px]">
          {view.output || "(no output text)"}
        </pre>
      )}
      {view.truncated && (
        <p className="text-muted-foreground">OMNI shortened this output before sending it.</p>
      )}
      {view.noResult && <p className="text-muted-foreground">{view.noResult}</p>}
    </div>
  );
}

/** Live view with a refresh button; reads only what Jackboy stored from OMNI's verified replies. */
export function OmniV3JobStatus({ jobId, initial }: { jobId: string; initial?: V3JobView }) {
  const read = useServerFn(getOmniV3Job);
  const [view, setView] = useState<V3JobView | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      setView(await read({ data: { jobId } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Status could not be read.");
    } finally {
      setBusy(false);
    }
  };
  const done = view?.ok && view.status !== null && TERMINAL.has(view.status) && !view.noResult;
  return (
    <div className="space-y-2 rounded-xl border border-border p-3 text-xs" aria-label="OMNI job status">
      <p className="text-sm font-semibold text-silver">OMNI job status</p>
      {view ? (
        <V3JobDetails view={view} />
      ) : (
        <p className="text-muted-foreground">Not checked yet.</p>
      )}
      {!done && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void refresh()}>
          {busy ? "Checking…" : "Check status"}
        </Button>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

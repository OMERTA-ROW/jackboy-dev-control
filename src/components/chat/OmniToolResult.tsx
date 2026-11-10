// Shows OMNI's real replies in chat: job ID, HTTP status, status and output, or the exact error.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { checkOmniJob, runOmniHandshake } from "@/lib/omni-link.functions";
import { Button } from "@/components/ui/button";
import { OmniV3JobStatus, type V3JobView } from "@/components/OmniV3JobStatus";

type JobResult = {
  status: string;
  summary: string;
  tests: { passed: boolean; output: string } | null;
  diffStat: string | null;
} | null;
type Sent = {
  sent: true;
  jobId: string;
  httpStatus: number;
  duplicate: boolean;
  status: string;
  result: JobResult;
  repo: string;
  kind: string;
  note: string;
};
type NotSent = {
  sent: false;
  ran: false;
  jobId: string | null;
  httpStatus: number | null;
  error: string;
};
type StatusReply =
  | { ok: true; httpStatus: number; job: { id: string; status: string; result: JobResult } }
  | { ok: false; httpStatus: number | null; error: string };
type Handshake = {
  verified: boolean;
  error?: string;
  httpStatus?: number | null;
  contract?: string | null;
  version?: string | null;
  capabilities?: string[];
};

export const OMNI_TOOLS = new Set([
  "sendOmniJob",
  "omniJobStatus",
  "omniDispatchResult",
  "testOmniLink",
]);

function Output({ result }: { result: JobResult }) {
  if (!result) return <p className="text-muted-foreground">OMNI has not reported output yet.</p>;
  return (
    <div className="space-y-1">
      {result.summary && <p>OMNI says: {result.summary}</p>}
      {result.tests && (
        <p className={result.tests.passed ? "text-success" : "text-destructive"}>
          Tests {result.tests.passed ? "passed" : "failed"}
        </p>
      )}
      {result.diffStat && (
        <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-[11px]">
          {result.diffStat}
        </pre>
      )}
      {result.tests?.output && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-[11px]">
          {result.tests.output}
        </pre>
      )}
    </div>
  );
}

function JobCard({ reply }: { reply: Sent }) {
  const check = useServerFn(checkOmniJob);
  const [status, setStatus] = useState(reply.status);
  const [result, setResult] = useState<JobResult>(reply.result);
  const [http, setHttp] = useState(reply.httpStatus);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = (await check({ data: { jobId: reply.jobId } })) as StatusReply;
      if (r.ok) {
        setStatus(r.job.status);
        setResult(r.job.result);
        setHttp(r.httpStatus);
      } else setError(r.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Status check failed.");
    } finally {
      setBusy(false);
    }
  };
  const finished = status === "completed" || status === "failed";
  return (
    <div
      className="my-2 space-y-2 rounded-xl border border-border p-3 text-xs"
      aria-label="OMNI job"
    >
      <p className="text-sm font-semibold text-silver">OMNI job sent</p>
      <ul className="space-y-0.5 text-muted-foreground">
        <li>
          Job ID: <code className="text-foreground">{reply.jobId}</code>
        </li>
        <li>
          OMNI reply: HTTP {http}
          {reply.duplicate ? " (already received)" : ""}
        </li>
        <li>
          Status:{" "}
          <strong
            className={
              status === "completed"
                ? "text-success"
                : status === "failed"
                  ? "text-destructive"
                  : "text-warning"
            }
          >
            {status}
          </strong>{" "}
          · {reply.kind} on <code>{reply.repo}</code>
        </li>
      </ul>
      <Output result={result} />
      <p className="text-muted-foreground">{reply.note}</p>
      {!finished && (
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

export function HandshakeResult({ r }: { r: Handshake }) {
  return (
    <div className="space-y-0.5 text-xs">
      <p className={r.verified ? "text-success" : "text-destructive"}>
        {r.verified ? "OMNI link verified" : `OMNI link failed: ${r.error ?? "unknown error"}`}
      </p>
      {r.httpStatus != null && <p className="text-muted-foreground">HTTP {r.httpStatus}</p>}
      {r.contract && (
        <p className="text-muted-foreground">
          Contract: <code>{r.contract}</code> · Version: <code>{r.version}</code>
        </p>
      )}
      {r.capabilities && r.capabilities.length > 0 && (
        <p className="text-muted-foreground">Capabilities: {r.capabilities.join(", ")}</p>
      )}
    </div>
  );
}

export function OmniToolResult({ name, output }: { name: string; output: unknown }) {
  if (!output || typeof output !== "object") return null;
  if (name === "sendOmniJob") {
    const o = output as Sent | NotSent | { blocked: true; reason: string };
    if ("blocked" in o)
      return (
        <p role="alert" className="my-2 text-sm text-destructive">
          OMNI job not sent: {o.reason}
        </p>
      );
    if (o.sent) return <JobCard reply={o} />;
    return (
      <div role="alert" className="my-2 rounded-xl border border-destructive/50 p-3 text-xs">
        <p className="text-sm font-semibold text-destructive">The OMNI job did not run</p>
        <p>{o.error}</p>
        {o.jobId && (
          <p className="text-muted-foreground">
            Job ID attempted: <code>{o.jobId}</code>
          </p>
        )}
      </div>
    );
  }
  if (name === "omniJobStatus") {
    const o = output as StatusReply;
    if (!o.ok)
      return (
        <p role="alert" className="my-2 text-sm text-destructive">
          {o.error}
        </p>
      );
    return (
      <div className="my-2 space-y-1 rounded-xl border border-border p-3 text-xs">
        <p>
          Job <code>{o.job.id}</code> · HTTP {o.httpStatus} · status <strong>{o.job.status}</strong>
        </p>
        <Output result={o.job.result} />
      </div>
    );
  }
  if (name === "omniDispatchResult") {
    const o = output as V3JobView;
    return (
      <div className="my-2">
        <OmniV3JobStatus jobId={o.jobId} initial={o} />
      </div>
    );
  }
  if (name === "testOmniLink")
    return (
      <div className="my-2 rounded-xl border border-border p-3">
        <HandshakeResult r={output as Handshake} />
      </div>
    );
  return null;
}

/** Owner button: runs the real handshake and shows OMNI's contract, version and capabilities. */
export function TestOmniLinkButton() {
  const run = useServerFn(runOmniHandshake);
  const [r, setR] = useState<Handshake | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      setR((await run()) as Handshake);
    } catch (e) {
      setR({ verified: false, error: e instanceof Error ? e.message : "Link test failed." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void go()}>
        {busy ? "Testing OMNI link…" : "Test OMNI link"}
      </Button>
      {r && (
        <div className="mt-2">
          <HandshakeResult r={r} />
        </div>
      )}
    </div>
  );
}

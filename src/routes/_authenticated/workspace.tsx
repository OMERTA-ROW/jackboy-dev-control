import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { GuidanceTip, PageHeader } from "@/components/AppShell";
import { inspect, type Finding } from "@/lib/diagnostics";
import { log } from "@/lib/jackboy-store";

export const Route = createFileRoute("/workspace")({
  head: () => ({
    meta: [
      { title: "Inspect & Diagnose — Jackboy" },
      { name: "description", content: "Paste code for local static diagnostics. Nothing leaves your browser." },
      { property: "og:title", content: "Inspect & Diagnose — Jackboy" },
      { property: "og:description", content: "Local code inspection and diagnostics workspace." },
    ],
  }),
  component: Workspace,
});

const SAMPLE = `// Sample snippet (demo)
const apiKey = "sk_live_1234567890abcd";
function load(data: any) {
  if (data.count == 0) console.log("empty");
  // TODO: handle errors
  return eval(data.expr);
}`;

const SEV: Record<Finding["severity"], string> = {
  error: "text-destructive border-destructive/40",
  warning: "text-warning border-warning/40",
  info: "text-silver-dim border-border",
};

function Workspace() {
  const [code, setCode] = useState(SAMPLE);
  const [findings, setFindings] = useState<Finding[] | null>(null);

  const run = () => {
    const f = inspect(code);
    setFindings(f);
    log(f.some((x) => x.severity === "error") ? "error" : "success", `Local inspection: ${f.length} finding(s) in ${code.split("\n").length} lines.`);
  };

  return (
    <>
      <PageHeader title="Inspect & Diagnose" subtitle="Static pattern checks run locally in your browser. This is not connected to any repository and does not modify code." />
      <GuidanceTip>Paste a snippet and run inspection. Findings are heuristics — verify before acting.</GuidanceTip>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="panel flex flex-col p-4">
          <label htmlFor="code" className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Source</label>
          <textarea id="code" value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false}
            className="min-h-72 flex-1 resize-y rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed" />
          <div className="mt-3 flex gap-2">
            <button onClick={run} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Run inspection</button>
            <button onClick={() => { setCode(""); setFindings(null); }} className="rounded-md border border-border px-4 py-2 text-sm">Clear</button>
          </div>
        </div>
        <div className="panel p-4" aria-live="polite">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-silver">Findings</h2>
          {findings === null && <p className="text-sm text-muted-foreground">Run an inspection to see results.</p>}
          {findings?.length === 0 && <p className="text-sm text-success">No issues matched the local rules.</p>}
          <ul className="space-y-2">
            {findings?.map((f, i) => (
              <li key={i} className={`rounded-md border bg-muted p-3 text-sm ${SEV[f.severity]}`}>
                <div className="flex justify-between font-mono text-xs"><span>L{f.line} · {f.rule}</span><span className="uppercase">{f.severity}</span></div>
                <div className="mt-1 text-foreground">{f.message}</div>
              </li>
            ))}
          </ul>
          {findings && findings.length > 0 && <p className="mt-4 text-xs text-muted-foreground">Fixes are not applied automatically. Code changes require a connected repository and your approval.</p>}
        </div>
      </div>
    </>
  );
}

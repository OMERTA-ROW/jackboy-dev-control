import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, XCircle, AlertTriangle, Search, Globe, Server, Radio } from "lucide-react";
import { PageHeader, GuidanceTip } from "@/components/AppShell";
import { checkConnectivity, runResearchSearch, type SearchResult } from "@/lib/research.functions";
import { ALLOWED_DOMAINS, RATE_LIMIT_PER_DAY, RATE_LIMIT_PER_MINUTE, SEARCH_TIMEOUT_MS } from "@/lib/search-policy";

export const Route = createFileRoute("/_authenticated/research")({
  head: () => ({
    meta: [
      { title: "Research & Connectivity — Jackboy" },
      { name: "description", content: "Server-side internet research with domain restrictions and connection status." },
      { property: "og:title", content: "Research & Connectivity — Jackboy" },
      { property: "og:description", content: "Secure, audited web research for Jackboy." },
    ],
  }),
  component: Research,
});

type Check = { state: "idle" | "ok" | "error" | "not_configured" | "checking"; detail: string };

function Badge({ c, label, icon: I }: { c: Check; label: string; icon: typeof Globe }) {
  const color = c.state === "ok" ? "text-success" : c.state === "error" ? "text-destructive" : c.state === "not_configured" ? "text-warning" : "text-muted-foreground";
  const S = c.state === "ok" ? CheckCircle2 : c.state === "error" ? XCircle : AlertTriangle;
  return (
    <li className="panel p-4">
      <div className="flex items-center gap-2 text-sm font-medium"><I className="h-4 w-4 text-silver" aria-hidden />{label}</div>
      <div className={`mt-2 flex items-center gap-1.5 text-sm ${color}`}><S className="h-4 w-4" aria-hidden />{c.state === "idle" ? "Not tested" : c.state === "checking" ? "Checking…" : c.state === "not_configured" ? "Not configured" : c.state === "ok" ? "Reachable" : "Failed"}</div>
      <p className="mt-1 text-xs text-muted-foreground">{c.detail}</p>
    </li>
  );
}

function Research() {
  const connFn = useServerFn(checkConnectivity);
  const searchFn = useServerFn(runResearchSearch);
  const idle: Check = { state: "idle", detail: "Run the test to check." };
  const [browser, setBrowser] = useState<Check>(idle);
  const [backend, setBackend] = useState<Check>(idle);
  const [api, setApi] = useState<Check>(idle);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ status: string; message: string; results: SearchResult[]; fetchedAt?: string } | null>(null);

  async function test() {
    const checking: Check = { state: "checking", detail: "" };
    setBrowser(checking); setBackend(checking); setApi(checking);
    const online = typeof navigator !== "undefined" ? navigator.onLine : false;
    const t0 = performance.now();
    try {
      const r = await connFn();
      const ms = Math.round(performance.now() - t0);
      setBrowser({ state: online ? "ok" : "error", detail: online ? `Browser online; reached the Jackboy server in ${ms} ms.` : "Browser reports offline." });
      setBackend(r.backend.ok ? { state: "ok", detail: `Database responded in ${r.backend.ms} ms.` } : { state: "error", detail: "Database query failed." });
      setApi({ state: r.search.state, detail: r.search.detail + (r.search.ms ? ` (${r.search.ms} ms)` : "") });
    } catch (e) {
      setBrowser({ state: online ? "error" : "error", detail: online ? "Browser online, but the Jackboy server could not be reached." : "Browser reports offline." });
      setBackend({ state: "error", detail: (e as Error).message });
      setApi({ state: "error", detail: "Not checked — server unavailable." });
    }
  }

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try { setOut(await searchFn({ data: { query: q } })); }
    catch (err) { setOut({ status: "error", message: (err as Error).message, results: [] }); }
    finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Research & Connectivity" subtitle="Phase 1 internet research runs only on the server, with an allowlist of reputable domains, timeouts, rate limits and an audit log." />
      <GuidanceTip>Run the connection test first. If the search API shows “Not configured”, the owner must add a search API key; no results are faked.</GuidanceTip>

      <section aria-labelledby="conn" className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="conn" className="text-sm font-semibold uppercase tracking-wider text-silver">Connection status</h2>
          <button onClick={test} className="rounded-md border border-electric/60 px-3 py-1.5 text-sm text-electric hover:bg-accent">Run connection test</button>
        </div>
        <ul className="grid gap-3 md:grid-cols-3">
          <Badge c={browser} label="Browser reachability" icon={Globe} />
          <Badge c={backend} label="Backend availability" icon={Server} />
          <Badge c={api} label="External search API" icon={Radio} />
        </ul>
      </section>

      <section aria-labelledby="srch" className="panel p-5">
        <h2 id="srch" className="text-lg font-semibold text-silver">Web research</h2>
        <form onSubmit={search} className="mt-3 flex gap-2">
          <label className="sr-only" htmlFor="q">Search query</label>
          <input id="q" value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} placeholder="e.g. sodium-ion battery cathode 2026" className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm" />
          <button disabled={busy || q.trim().length < 2} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"><Search className="h-4 w-4" />{busy ? "Searching…" : "Search"}</button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">Limits: {RATE_LIMIT_PER_MINUTE}/minute, {RATE_LIMIT_PER_DAY}/day per user · {SEARCH_TIMEOUT_MS / 1000}s timeout · {ALLOWED_DOMAINS.length} allowed domains · every request is audited.</p>

        {out && (
          <div className="mt-4">
            <p role="status" className={`text-sm ${out.status === "ok" ? "text-success" : out.status === "not_configured" ? "text-warning" : "text-destructive"}`}>{out.message}</p>
            {out.status === "ok" && <p className="text-xs text-muted-foreground">Live results · fetched {out.fetchedAt ? new Date(out.fetchedAt).toLocaleString() : ""} · source snippets are claims, not verified facts.</p>}
            <ul className="mt-3 space-y-3">
              {out.results.map((r) => (
                <li key={r.url} className="rounded-md border border-border p-3">
                  <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-electric underline">{r.title}</a>
                  <div className="text-[11px] text-muted-foreground">{r.host}{r.age ? ` · ${r.age}` : ""}</div>
                  <p className="mt-1 text-sm text-muted-foreground">{r.snippet}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
        <details className="mt-4 text-xs text-muted-foreground"><summary className="cursor-pointer">Allowed domains</summary><p className="mt-2">{ALLOWED_DOMAINS.join(", ")}</p></details>
      </section>
    </>
  );
}

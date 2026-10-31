import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { isSpeculative, type Evidence, type RazulFinding } from "@/lib/razul";
import { importFinding, razulStatus, routeFinding, searchRazul, sendFeedback } from "@/lib/razul.functions";

export const Route = createFileRoute("/_authenticated/razul")({
  head: () => ({
    meta: [
      { title: "RA'SUL Intelligence — Jackboy" },
      { name: "description", content: "Sourced, evidence-classified discoveries from RA'SUL routed into Jackboy proposals and OMNI sandbox tasks." },
      { property: "og:title", content: "RA'SUL Intelligence — Jackboy" },
      { property: "og:description", content: "Timestamped, cited intelligence feed with outcome feedback to RA'SUL." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Razul,
});

type Data = Awaited<ReturnType<typeof razulStatus>>;
type Live = RazulFinding & { priority: number };
const btn = "rounded-md border border-border px-2.5 py-1 text-xs hover:border-electric disabled:opacity-40";
const input = "rounded-md border border-input bg-background px-3 py-2 text-sm";

function EvidenceBadge({ e }: { e: Evidence }) {
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase ${isSpeculative(e) ? "border-destructive/50 text-destructive" : "border-success/50 text-success"}`}>{e.replace("_", " ")}{isSpeculative(e) ? " · unverified" : ""}</span>;
}
function Sources({ s }: { s: { url: string; title?: string | undefined }[] }) {
  return <ul className="mt-1 text-xs">{s.map((x) => <li key={x.url}><a className="text-electric underline break-all" href={x.url} target="_blank" rel="noopener noreferrer">{x.title || x.url}</a></li>)}</ul>;
}

function Razul() {
  const f = { load: useServerFn(razulStatus), search: useServerFn(searchRazul), imp: useServerFn(importFinding), route: useServerFn(routeFinding), fb: useServerFn(sendFeedback) };
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [live, setLive] = useState<{ findings: Live[]; dropped: number } | null>(null);
  const [project, setProject] = useState("");
  const refresh = useCallback(() => f.load().then(setD).catch((e) => setErr((e as Error).message)), [f.load]);
  useEffect(() => { refresh(); }, [refresh]);
  const act = async (p: Promise<unknown>) => { setErr(null); try { await p; await refresh(); } catch (e) { setErr((e as Error).message); } };

  if (!d) return <><PageHeader title="RA'SUL Intelligence" subtitle="Loading…" />{err && <p className="text-sm text-destructive">{err}</p>}</>;
  const mgr = d.role !== "member";

  return (
    <>
      <PageHeader title="RA'SUL Intelligence" subtitle="OMNI's public-intelligence & historical knowledge agent, working hand-in-hand with Jackboy." />
      {err && <p role="alert" className="mb-3 text-sm text-destructive">{err}</p>}

      <section className="panel mb-4 rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className={`rounded-full border px-3 py-1 text-xs ${d.live ? "border-success text-success" : "border-destructive/60 text-destructive"}`}>{d.live ? "LIVE · verified" : d.configured ? "CONFIGURED · unreachable" : "DISCONNECTED"}</span>
          <span className="text-xs text-muted-foreground">{d.detail}</span>
          <button className={btn} onClick={refresh}>Re-test</button>
        </div>
        {!d.configured && <p className="mt-2 text-xs text-muted-foreground">Owner action: add secrets <code>RAZUL_API_URL</code> (https) and <code>RAZUL_API_KEY</code> (scoped, read + feedback only). No findings are shown until a live response arrives — Jackboy never invents sources.</p>}
      </section>

      <section className="panel mb-4 rounded-lg border border-border p-4">
        <h2 className="mb-2 text-sm font-semibold">Search / feed</h2>
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); act(f.search({ data: { q, mode: "search" } }).then(setLive)); }}>
          <input className={`${input} flex-1`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Any field, era or technology" aria-label="Search RA'SUL" />
          <button className={btn} disabled={!d.configured || !q.trim()}>Search</button>
          <button type="button" className={btn} disabled={!d.configured} onClick={() => act(f.search({ data: { q: "", mode: "feed" } }).then(setLive))}>Latest feed</button>
        </form>
        {live && <p className="mt-2 text-xs text-muted-foreground">{live.findings.length} sourced results · {live.dropped} rejected for missing source/timestamp/evidence</p>}
        <ul className="mt-3 space-y-3">
          {live?.findings.map((x) => (
            <li key={x.id} className="rounded border border-border p-3">
              <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{x.title}</strong><EvidenceBadge e={x.evidence} /><span className="text-xs text-muted-foreground">{x.field} · {new Date(x.observed_at).toLocaleString()} · priority {x.priority}</span></div>
              <p className="mt-1 text-xs text-muted-foreground">{x.summary}</p><Sources s={x.sources} />
              {mgr && <button className={`${btn} mt-2`} onClick={() => act(f.imp({ data: { finding: x } }))}>Import to queue</button>}
            </li>
          ))}
        </ul>
      </section>

      <section className="panel rounded-lg border border-border p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">Prioritized queue ({d.findings.length})</h2>
          {mgr && <select className={input} value={project} onChange={(e) => setProject(e.target.value)} aria-label="Target project"><option value="">Target project…</option>{d.projects.map((p: { id: string; name: string }) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
        </div>
        <p className="mb-2 text-xs text-muted-foreground">OMNI tasks are queued only, not sent, until OMNI's API is verified. Feedback is delivered to RA'SUL only when live; otherwise it is kept as queued.</p>
        {d.findings.length === 0 && <p className="text-sm text-muted-foreground">Empty. Import findings from a live RA'SUL search.</p>}
        <ul className="space-y-3">
          {d.findings.map((x: any) => {
            const fbs = d.feedback.filter((b: any) => b.finding_id === x.id);
            return (
              <li key={x.id} className="rounded border border-border p-3">
                <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{x.title}</strong><EvidenceBadge e={x.evidence} /><span className="text-xs text-muted-foreground">priority {x.priority} · {x.status}</span></div>
                <Sources s={x.sources} />
                {mgr && <div className="mt-2 flex flex-wrap gap-1.5">
                  <button className={btn} disabled={!project} onClick={() => act(f.route({ data: { id: x.id, projectId: project, as: "proposal" } }))}>→ Proposal</button>
                  <button className={btn} disabled={!project} onClick={() => act(f.route({ data: { id: x.id, projectId: project, as: "research" } }))}>→ OMNI code research</button>
                  <button className={btn} disabled={!project} onClick={() => act(f.route({ data: { id: x.id, projectId: project, as: "sandbox_test" } }))}>→ OMNI sandbox test</button>
                  {(["useful", "not_relevant", "incorrect", "built", "test_passed", "test_failed"] as const).map((o) => <button key={o} className={btn} onClick={() => act(f.fb({ data: { id: x.id, outcome: o, note: "" } }))}>{o.replace("_", " ")}</button>)}
                </div>}
                {fbs.length > 0 && <p className="mt-1 text-xs text-muted-foreground">Feedback: {fbs.map((b: any) => `${b.outcome} (${b.sent_at ? "sent" : "queued"})`).join(", ")}</p>}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

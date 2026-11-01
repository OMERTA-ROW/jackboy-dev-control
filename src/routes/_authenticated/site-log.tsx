import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { deliverNow, exportSiteLog, getPatterns, getSiteLog, researchSave, researchSearch, setSubscription } from "@/lib/site-log.functions";

export const Route = createFileRoute("/_authenticated/site-log")({
  head: () => ({
    meta: [
      { title: "Site Log & Research — Jackboy" },
      { name: "description", content: "Permanent, searchable development log with report delivery status and license-checked code research." },
      { property: "og:title", content: "Site Log & Research — Jackboy" },
      { property: "og:description", content: "Permanent development log, report delivery and license-checked research." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SiteLog,
});

const CATS = ["", "activity", "inspection", "patch", "test", "approval", "deployment", "error", "rollback", "research", "delivery", "config"];
const STATUSES = ["", "info", "ok", "pending", "blocked", "failed", "rolled_back"];
const btn = "rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50";
const input = "rounded-md border border-border bg-background p-2 text-sm";
type Log = Awaited<ReturnType<typeof getSiteLog>>;
type Hit = Awaited<ReturnType<typeof researchSearch>>[number];

function SiteLog() {
  const get = useServerFn(getSiteLog), exp = useServerFn(exportSiteLog), sub = useServerFn(setSubscription), deliver = useServerFn(deliverNow);
  const search = useServerFn(researchSearch), save = useServerFn(researchSave), pats = useServerFn(getPatterns);
  const [f, setF] = useState({ q: "", category: "", status: "", projectId: "" });
  const [d, setD] = useState<Log | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [rq, setRq] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [patterns, setPatterns] = useState<Awaited<ReturnType<typeof getPatterns>>>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => get({ data: f }).then(setD).catch((e) => setMsg((e as Error).message)), [get, f]);
  useEffect(() => { void load(); pats().then(setPatterns).catch(() => {}); }, [load, pats]);
  const wrap = async (fn: () => Promise<unknown>) => { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } };
  const download = (format: "csv" | "json") => wrap(async () => {
    const r = await exp({ data: { ...f, format } });
    const url = URL.createObjectURL(new Blob([r.body], { type: format === "csv" ? "text/csv" : "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `jackboy-site-log.${format}`; a.click(); URL.revokeObjectURL(url);
  });
  const names = Object.fromEntries((d?.projects ?? []).map((p) => [p.id, p.name]));

  return (
    <>
      <PageHeader title="Site Log & Research" subtitle="Every Jackboy action, kept permanently. Credentials and personal data are removed before anything is saved or sent." />
      {msg && <p role="status" className="mb-4 text-sm text-warning">{msg}</p>}

      <section className="panel mb-4 p-4" aria-label="Report delivery">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-silver">Report delivery</h2>
        <ul className="mt-2 grid gap-3 md:grid-cols-3">
          {d?.targets.map((t) => (
            <li key={t.target} className="text-sm">
              <div className="flex items-center justify-between"><span className="font-medium">{t.label}</span>
                <span className={`text-xs uppercase ${t.configured ? "text-success" : "text-warning"}`}>{t.configured ? "endpoint set (unverified)" : "not connected"}</span></div>
              <p className="text-xs text-muted-foreground">{t.pending} waiting · {t.sent} sent · {t.failed} failed{t.categories.length ? ` · only ${t.categories.join(", ")}` : ""}</p>
              {t.lastError && <p className="text-xs text-muted-foreground">Last: {t.lastError}</p>}
              <label className="mt-1 flex items-center gap-2 text-xs"><input type="checkbox" checked={t.enabled} disabled={busy} onChange={(e) => wrap(async () => { await sub({ data: { target: t.target, enabled: e.target.checked } }); await load(); })} />Queue reports</label>
            </li>
          ))}
        </ul>
        <button className={`${btn} mt-3`} disabled={busy} onClick={() => wrap(async () => { const r = await deliver(); setMsg(`Delivery: ${r.sent} sent, ${r.waiting} waiting for an endpoint, ${r.failed} failed.`); await load(); })}>Try delivery now</button>
      </section>

      <section className="panel mb-4 p-4">
        <div className="flex flex-wrap gap-2">
          <input aria-label="Search log" className={`${input} flex-1`} placeholder="Search summary, action, repo or PR" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          <select aria-label="Category" className={input} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATS.map((c) => <option key={c} value={c}>{c || "All categories"}</option>)}</select>
          <select aria-label="Status" className={input} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{STATUSES.map((c) => <option key={c} value={c}>{c || "All statuses"}</option>)}</select>
          <select aria-label="Project" className={input} value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })}><option value="">All projects</option>{d?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <button className={btn} disabled={busy} onClick={() => download("csv")}>Export CSV</button>
          <button className={btn} disabled={busy} onClick={() => download("json")}>Export JSON</button>
        </div>
        <ul className="mt-3 divide-y divide-border text-sm">
          {d?.rows.map((r) => (
            <li key={r["id"]} className="py-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{new Date(r["at"] ?? "").toLocaleString()}</span><span>· {r["category"]}</span>
                <span className={r["status"] === "ok" ? "text-success" : r["status"] === "failed" ? "text-destructive" : r["status"] === "blocked" || r["status"] === "pending" ? "text-warning" : ""}>· {r["status"]}</span>
                {r["project_id"] && <span>· {names[r["project_id"]] ?? "project"}</span>}<span>· {(r["actor"] ?? "").split(":")[0]}</span>
              </div>
              <p>{r["summary"]}</p>
              <p className="text-xs text-muted-foreground">
                {r["branch"] && <>branch {r["branch"]} </>}{r["commit_sha"] && <>· {r["commit_sha"]?.slice(0, 7)} </>}{r["tests"] && <>· tests {r["tests"]} </>}{r["license"] && <>· license {r["license"]} </>}
                {r["pr_url"] && <a className="text-primary underline" href={r["pr_url"]} target="_blank" rel="noreferrer">PR</a>}{" "}
                {r["source_url"] && <a className="text-primary underline" href={r["source_url"]} target="_blank" rel="noreferrer">source</a>}
              </p>
            </li>
          ))}
          {d && !d.rows.length && <li className="py-2 text-muted-foreground">No entries match.</li>}
        </ul>
      </section>

      <section className="panel mb-4 p-4" aria-label="Code research">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-silver">Code research (GitHub, public repos)</h2>
        <p className="mt-1 text-xs text-muted-foreground">Uses GitHub's official search. Results are links with license checks; nothing is copied or run. Only MIT, Apache, BSD, ISC and similar licenses may be adapted, with attribution.</p>
        <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); void wrap(async () => setHits(await search({ data: { query: rq } }))); }}>
          <input aria-label="Research query" className={`${input} flex-1`} placeholder='e.g. "hmac timingSafeEqual" language:typescript' value={rq} onChange={(e) => setRq(e.target.value)} />
          <button className={btn} disabled={busy || rq.trim().length < 3}>{busy ? "Searching…" : "Search"}</button>
        </form>
        {hits && <ul className="mt-3 space-y-2 text-sm">{hits.map((h) => (
          <li key={h.url} className="flex flex-wrap items-center justify-between gap-2">
            <span><a className="text-primary underline" href={h.url} target="_blank" rel="noreferrer">{h.repo}/{h.path}</a> <span className="text-xs text-muted-foreground">· {h.license ?? "no license"} · score {h.score}</span> {!h.licenseOk && <span className="text-xs text-warning">reference only</span>}</span>
            <button className={btn} disabled={busy} onClick={() => wrap(async () => { await save({ data: { hit: h, title: `${h.repo}: ${h.path.split("/").pop()}` } }); setPatterns(await pats()); setMsg("Saved as an unverified pattern."); })}>Save pattern</button>
          </li>))}{!hits.length && <li className="text-muted-foreground">No results.</li>}</ul>}
        <h3 className="mt-4 text-xs font-semibold uppercase text-muted-foreground">Pattern library ({patterns.length})</h3>
        <ul className="mt-1 space-y-1 text-xs">{patterns.map((p) => (
          <li key={p.id}>{p.title} · {p.origin} · score {p.score} · {p.license ?? "n/a"} · {p.verified_count > 0 ? <span className="text-success">verified ×{p.verified_count}</span> : <span className="text-warning">unverified</span>} {p.source_url && <a className="text-primary underline" href={p.source_url} target="_blank" rel="noreferrer">source</a>}</li>
        ))}</ul>
      </section>
    </>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { addFeed, checkFeedsNow, getFeeds, tagItem, updateFeed } from "@/lib/update-writer.functions";

export const Route = createFileRoute("/_authenticated/feeds")({
  head: () => ({
    meta: [
      { title: "Live Feeds — Jackboy" },
      { name: "description", content: "News feeds, website change monitors and incoming alerts that inform Jackboy's updates." },
      { property: "og:title", content: "Live Feeds — Jackboy" },
      { property: "og:description", content: "Owner-managed info sources tagged to projects." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Feeds,
});

type D = Awaited<ReturnType<typeof getFeeds>>;
const input = "rounded-md border border-input bg-background px-3 py-2 text-sm";
const btn = "rounded-md border border-border px-3 py-1.5 text-xs hover:border-electric disabled:opacity-40";
const KIND = { rss: "News / RSS feed", page: "Website change monitor", webhook: "Incoming alerts (Zapier, Firecrawl…)" } as const;

function Feeds() {
  const f = { load: useServerFn(getFeeds), add: useServerFn(addFeed), upd: useServerFn(updateFeed), tag: useServerFn(tagItem), check: useServerFn(checkFeedsNow) };
  const [d, setD] = useState<D | null>(null);
  const [form, setForm] = useState({ kind: "rss" as keyof typeof KIND, name: "", url: "", projectIds: [] as string[] });
  const [secret, setSecret] = useState<{ url: string; token: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = useCallback(() => f.load().then(setD).catch((e) => setErr((e as Error).message)), [f.load]);
  useEffect(() => { refresh(); }, [refresh]);
  const act = async (p: Promise<unknown>) => { setErr(null); try { await p; await refresh(); } catch (e) { setErr((e as Error).message); } };
  const names = (ids: string[]) => ids.map((id) => d?.projects.find((p) => p.id === id)?.name).filter(Boolean).join(", ") || "untagged";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setSecret(null);
    try {
      const r = await f.add({ data: form });
      if (r.token) setSecret({ url: `${window.location.origin}/api/public/feeds/${r.id}`, token: r.token });
      setForm({ ...form, name: "", url: "" }); await refresh();
    } catch (x) { setErr((x as Error).message); }
  };

  return (
    <>
      <PageHeader title="Live Feeds" subtitle="Sources Jackboy reads before writing updates. Feeds are checked each hourly run; items are tagged to projects." />
      {err && <p role="alert" className="mb-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive">{err}</p>}
      {msg && <p aria-live="polite" className="mb-4 rounded-md border border-border p-3 text-sm">{msg}</p>}
      {secret && (
        <div className="panel mb-4 border-electric p-4 text-xs">
          <div className="mb-1 font-semibold">Webhook created — copy these now. The key is shown only once.</div>
          <div>URL: <span className="font-mono break-all">{secret.url}</span></div>
          <div>Header <span className="font-mono">x-jackboy-token</span>: <span className="font-mono break-all">{secret.token}</span></div>
          <div className="mt-1 text-muted-foreground">Send JSON like {"{"}"title", "url", "summary"{"}"} with POST. If the service can't set headers, add <span className="font-mono">?token=…</span> to the URL.</div>
        </div>
      )}

      <form onSubmit={submit} className="panel mb-6 grid gap-2 p-4 md:grid-cols-4">
        <select aria-label="Source type" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as keyof typeof KIND })} className={input}>
          {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input required aria-label="Source name" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={input} />
        {form.kind !== "webhook" ? <input required aria-label="URL" placeholder="https://…" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className={input} /> : <span className="self-center text-xs text-muted-foreground">You'll get a private URL + key.</span>}
        <select multiple aria-label="Tag to projects" value={form.projectIds} onChange={(e) => setForm({ ...form, projectIds: [...e.target.selectedOptions].map((o) => o.value) })} className={`${input} h-20`}>
          {d?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <p className="text-xs text-muted-foreground md:col-span-3">No projects selected → items are tagged to any project whose name appears in them.</p>
        <button className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground">Add source</button>
      </form>

      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-silver">Sources</h2>
        <button className={btn} onClick={() => f.check().then((r) => { setMsg(`${r.added} new item(s).`); refresh(); }).catch((e) => setErr(e.message))}>Check feeds now</button>
      </div>
      <ul className="mb-6 grid gap-2 md:grid-cols-2">
        {d?.sources.length === 0 && <li className="text-sm text-muted-foreground">No sources yet.</li>}
        {d?.sources.map((s) => (
          <li key={s.id} className="panel p-3 text-xs">
            <div className="flex justify-between gap-2"><span className="font-semibold text-sm">{s.name}</span><span className={s.last_error ? "text-destructive" : s.last_checked_at ? "text-success" : "text-muted-foreground"}>{s.last_error ? `Error: ${s.last_error}` : s.last_checked_at ? `OK ${new Date(s.last_checked_at).toLocaleString()}` : "Not checked yet"}</span></div>
            <div className="text-muted-foreground">{KIND[s.kind]}{s.url ? ` · ${s.url}` : ""} · Projects: {names(s.project_ids)}</div>
            <div className="mt-2 flex gap-2">
              <button className={btn} onClick={() => act(f.upd({ data: { id: s.id, active: !s.active } }))}>{s.active ? "Pause" : "Resume"}</button>
              <button className={btn} onClick={() => { if (confirm(`Remove ${s.name} and its items?`)) act(f.upd({ data: { id: s.id, remove: true } })); }}>Remove</button>
            </div>
          </li>
        ))}
      </ul>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Latest items</h2>
      <ul className="space-y-2">
        {d?.items.length === 0 && <li className="text-sm text-muted-foreground">Nothing yet.</li>}
        {d?.items.map((i) => (
          <li key={i.id} className="panel p-3 text-xs">
            <div className="flex justify-between gap-2">
              {i.url ? <a href={i.url} target="_blank" rel="noreferrer" className="font-medium text-sm text-electric underline">{i.title}</a> : <span className="font-medium text-sm">{i.title}</span>}
              <span className="text-muted-foreground">{new Date(i.published_at ?? i.created_at).toLocaleString()}</span>
            </div>
            {i.summary && <p className="mt-1 text-muted-foreground line-clamp-2">{i.summary}</p>}
            <label className="mt-1 flex items-center gap-2">Tagged:
              <select multiple aria-label="Projects for item" value={i.project_ids} onChange={(e) => act(f.tag({ data: { id: i.id, projectIds: [...e.target.selectedOptions].map((o) => o.value) } }))} className="rounded-md border border-input bg-background px-2 py-1 text-xs">
                {d.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          </li>
        ))}
      </ul>
    </>
  );
}

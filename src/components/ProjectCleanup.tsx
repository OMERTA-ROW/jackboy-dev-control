import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { archiveDeadProjects, detectSiteAddresses, findDeadProjects } from "@/lib/project-resync.functions";
import { btn, primaryBtn } from "@/components/ProjectBits";

type Dead = { id: string; name: string; repo: string | null; reason: string };

/** Owner tools: fill missing site addresses, and review dead projects before archiving. Never archives without confirmation. */
export function ProjectCleanup({ onChange }: { onChange: () => void }) {
  const detect = useServerFn(detectSiteAddresses);
  const find = useServerFn(findDeadProjects);
  const archive = useServerFn(archiveDeadProjects);
  const [busy, setBusy] = useState<string | null>(null);
  const [sites, setSites] = useState<Awaited<ReturnType<typeof detectSiteAddresses>> | null>(null);
  const [dead, setDead] = useState<Dead[] | null>(null);
  const [pick, setPick] = useState<string[]>([]);
  const [msg, setMsg] = useState("");
  const [note, setNote] = useState("");

  async function go<T>(k: string, f: () => Promise<T>) {
    setBusy(k); setMsg("");
    try { return await f(); } catch (e) { setMsg((e as Error).message); return null; } finally { setBusy(null); }
  }

  return (
    <div className="panel mb-4 flex flex-col gap-3 p-4" aria-label="Project cleanup">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={!!busy} onClick={async () => { const r = await go("sites", () => detect()); if (r) { setSites(r); onChange(); } }}>{busy === "sites" ? "Detecting…" : "Detect site addresses"}</button>
        <button type="button" className={btn} disabled={!!busy} onClick={async () => { const r = await go("dead", () => find()); if (r) { setDead(r); setPick(r.map((d) => d.id)); } }}>{busy === "dead" ? "Checking repos…" : "Archive dead projects"}</button>
      </div>
      {note && <p aria-live="polite" className="text-sm">{note}</p>}
      {msg && <p role="alert" className="text-sm text-destructive">{msg}</p>}
      {sites && (
        <div className="text-sm" aria-live="polite">
          <p>{sites.filled.length ? `Filled ${sites.filled.length}: ${sites.filled.map((f) => `${f.name} → ${f.url}`).join(", ")}.` : "No site address could be detected automatically."}</p>
          {sites.missing.length > 0 && <ul className="mt-1 flex flex-wrap gap-2">{sites.missing.map((m) => <li key={m.id}><Link to="/project/$id" params={{ id: m.id }} className={btn}>Add site address: {m.name}</Link></li>)}</ul>}
        </div>
      )}
      {dead && (
        <div className="text-sm">
          {dead.length === 0 ? <p>No dead projects found. Nothing to archive.</p> : <>
            <p className="font-medium">Review before archiving ({dead.length}). History is kept and you can restore anytime.</p>
            <ul className="mt-2 space-y-1">{dead.map((d) => (
              <li key={d.id}><label className="flex items-center gap-2"><input type="checkbox" checked={pick.includes(d.id)} onChange={() => setPick(pick.includes(d.id) ? pick.filter((x) => x !== d.id) : [...pick, d.id])} /><span>{d.name}{d.repo ? ` · ${d.repo}` : ""} — <span className="text-muted-foreground">{d.reason}</span></span></label></li>
            ))}</ul>
            <div className="mt-2 flex gap-2">
              <button type="button" className={primaryBtn} disabled={!!busy || !pick.length} onClick={async () => { const r = await go("arch", () => archive({ data: { ids: pick } })); if (r) { setDead(null); onChange(); setNote(r.map((x) => `${x.name}: ${x.archived ? "archived" : x.reason}`).join(" · ")); } }}>Archive {pick.length} selected</button>
              <button type="button" className={btn} onClick={() => setDead(null)}>Cancel</button>
            </div>
          </>}
        </div>
      )}
    </div>
  );
}

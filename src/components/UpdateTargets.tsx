import { useEffect, useState } from "react";
import { enrollTarget, listTargets, revokeTarget } from "@/lib/update-targets.functions";

const input = "rounded-md border border-border bg-background px-2 py-1 text-sm";
const btn = "rounded-md border border-border px-3 py-1 text-sm hover:border-electric disabled:opacity-50";

/** Enrolled updater clients for one project: inventory, install/health history, one-time tokens and revocation. */
export function UpdateTargets({ projectId }: { projectId: string }) {
  const [d, setD] = useState<{ targets: any[]; installs: any[] } | null>(null);
  const [form, setForm] = useState({ name: "", channel: "test" as "test" | "beta" | "live", platform: "web" });
  const [token, setToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => listTargets().then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const targets = (d?.targets ?? []).filter((t) => t.project_id === projectId);
  return (
    <section className="hex-panel rounded-lg border border-border p-4 space-y-3" aria-labelledby="targets-h">
      <h2 id="targets-h" className="font-semibold">Updater targets</h2>
      <p className="text-xs text-muted-foreground">Each target runs the updater client: it verifies the Ed25519 signature and SHA-256 hash before installing, then reports install and health. A failed health report can roll the release back. Nothing is installed unless a target reports it.</p>
      {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
      <form className="flex flex-wrap gap-2" onSubmit={async (e) => { e.preventDefault(); setErr(null); try { const r = await enrollTarget({ data: { project_id: projectId, ...form } }); setToken(r.token); setForm({ ...form, name: "" }); load(); } catch (x: any) { setErr(x.message); } }}>
        <input className={input} required placeholder="Target name" aria-label="Target name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <select className={input} aria-label="Channel" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as "test" })}><option>test</option><option>beta</option><option>live</option></select>
        <input className={input} aria-label="Platform" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })} />
        <button className={btn}>Enroll target</button>
      </form>
      {token && <div role="status" className="rounded-md border border-electric/60 p-2 text-xs"><p>Target token (shown once — put it in the target's own secret store):</p><code className="break-all">{token}</code> <button className={btn} onClick={() => setToken(null)}>Done</button></div>}
      {targets.length === 0 ? <p className="text-sm text-muted-foreground">No targets enrolled for this project.</p> : (
        <ul className="divide-y divide-border text-sm">{targets.map((t) => (
          <li key={t.id} className="py-2 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <strong>{t.name}</strong><span className="text-xs text-muted-foreground">{t.channel} · {t.platform} · v{t.current_version ?? "?"}</span>
              <span className={t.state === "healthy" ? "text-emerald" : t.state === "failed" || t.state === "revoked" ? "text-destructive" : "text-muted-foreground"}>{t.state}</span>
              <span className="text-xs text-muted-foreground">{t.last_seen_at ? `seen ${new Date(t.last_seen_at).toLocaleString()}` : "never checked in"}</span>
              {!t.revoked_at && <button className={btn} onClick={async () => { await revokeTarget({ data: { id: t.id } }); load(); }}>Revoke</button>}
            </div>
            <ul className="text-xs text-muted-foreground">{(d?.installs ?? []).filter((i) => i.target_id === t.id).slice(0, 8).map((i) => <li key={i.id}>{new Date(i.created_at).toLocaleString()} · {i.version} · {i.phase}{i.detail ? ` — ${i.detail}` : ""}</li>)}</ul>
          </li>))}</ul>)}
    </section>
  );
}

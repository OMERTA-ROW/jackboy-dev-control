import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/AppShell";
import { Switch } from "@/components/ui/switch";
import { connectAndScan, fixScan, getAutopilot, scanNow, setMasterAutopilot, setProjectAutopilot } from "@/lib/autopilot.functions";

export const Route = createFileRoute("/_authenticated/autopilot")({
  head: () => ({
    meta: [
      { title: "Autopilot — Jackboy" },
      { name: "description", content: "Master and per-project Autopilot switches, site scans and automatic fixes." },
      { property: "og:title", content: "Autopilot — Jackboy" },
      { property: "og:description", content: "Turn Autopilot on or off, see scan findings and what Jackboy shipped." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AutopilotPage,
});

type Data = Awaited<ReturnType<typeof getAutopilot>>;
const btn = "rounded-md border border-border px-3 py-1.5 text-xs hover:border-electric disabled:opacity-40";
const CONNECT: Record<string, string> = { not_started: "Not connected", no_repo: "No repo set", waiting_github: "Waiting for GitHub token", pr_open: "Connection PR opened", failed: "Connection failed" };
const sev = (s: string) => (s === "high" ? "text-destructive" : s === "medium" ? "text-electric" : "text-muted-foreground");

export function MasterSwitch({ compact = false }: { compact?: boolean }) {
  const load = useServerFn(getAutopilot), setMaster = useServerFn(setMasterAutopilot);
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => { load().then((r) => setOn(r.master)).catch(() => setOn(null)); }, [load]);
  if (on === null) return null;
  return (
    <div className={`panel flex items-center justify-between gap-4 ${compact ? "p-3" : "p-4"} ${on ? "border-success/60" : ""}`}>
      <div>
        <div className="text-sm font-semibold">Autopilot {on ? <span className="text-success">ON</span> : <span className="text-muted-foreground">OFF</span>}</div>
        <p className="text-xs text-muted-foreground">{on ? "Fixes ship automatically for projects with Autopilot on, after checks pass." : "Every fix waits in the Update Queue for your approval."} <Link to="/autopilot" className="text-electric underline">Per-project switches</Link></p>
      </div>
      <Switch aria-label="Master Autopilot" checked={on} onCheckedChange={async (v) => { setOn(v); try { await setMaster({ data: { on: v, grantId: v ? await stepUp("autonomy_toggle", "autopilot:master") : undefined } }); } catch { setOn(!v); } }} />
    </div>
  );
}

function AutopilotPage() {
  const load = useServerFn(getAutopilot), setMaster = useServerFn(setMasterAutopilot), setProj = useServerFn(setProjectAutopilot);
  const scan = useServerFn(scanNow), fix = useServerFn(fixScan), connect = useServerFn(connectAndScan);
  const [d, setD] = useState<Data | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const refresh = useCallback(() => load().then(setD).catch((e) => setMsg({ ok: false, text: (e as Error).message })), [load]);
  useEffect(() => { refresh(); }, [refresh]);
  const act = async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(null); refresh(); }
  };
  if (!d) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <>
      <PageHeader title="Autopilot" subtitle="When on, Jackboy scans your sites, writes fixes and ships them through pull requests and a staged rollout with automatic rollback." />
      {!d.githubConfigured && <p className="mb-4 rounded-md border border-border p-3 text-xs text-muted-foreground">GitHub isn't connected yet, so Jackboy can scan and write fixes but can't open pull requests or ship. Add the <span className="font-mono">GITHUB_TOKEN</span> secret to enable it.</p>}
      {d.paused && <p className="mb-4 rounded-md border border-destructive/40 p-3 text-xs text-destructive">Paused: {d.paused}. Resume from the Update Queue.</p>}
      {msg && <p role="status" className={`mb-4 rounded-md border p-3 text-sm ${msg.ok ? "border-border" : "border-destructive/40 text-destructive"}`}>{msg.text}</p>}

      <div className="panel mb-6 flex items-center justify-between gap-4 p-5">
        <div>
          <h2 className="text-lg font-semibold">Master Autopilot {d.master ? <span className="text-success">ON</span> : <span className="text-muted-foreground">OFF</span>}</h2>
          <p className="text-xs text-muted-foreground">Both this and a project's switch must be on for that project to ship automatically. Changes to sign-in, payments, secrets, permissions or the database, and repos without automated checks, always wait for you.</p>
        </div>
        <Switch aria-label="Master Autopilot" checked={d.master} onCheckedChange={(v) => act("master", async () => { await setMaster({ data: { on: v, grantId: v ? await stepUp("autonomy_toggle", "autopilot:master") : undefined } }); return `Master Autopilot ${v ? "on" : "off"}.`; })} />
      </div>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Projects</h2>
      {d.projects.length === 0 ? <p className="mb-8 text-sm text-muted-foreground">No projects yet. <Link to="/projects" className="text-electric underline">Add one</Link>.</p> : (
        <ul className="mb-8 grid gap-3 md:grid-cols-2">
          {d.projects.map((p) => {
            const last = d.scans.find((s) => s.project_id === p.id);
            return (
              <li key={p.id} className="panel p-4 text-sm">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold">{p.name}</div>
                    <div className="text-xs text-muted-foreground">{p.site_url ?? "No site URL"} · {CONNECT[p.connect_state] ?? p.connect_state}{p.connect_pr_url && <> · <a href={p.connect_pr_url} target="_blank" rel="noreferrer" className="text-electric underline">PR</a></>}</div>
                    {p.connect_error && <div className="text-xs text-destructive">{p.connect_error}</div>}
                  </div>
                  <label className="flex items-center gap-2 text-xs">Autopilot <Switch aria-label={`Autopilot for ${p.name}`} checked={p.autopilot} onCheckedChange={(v) => act(p.id, async () => { await setProj({ data: { id: p.id, on: v, grantId: v ? await stepUp("autonomy_toggle", `autopilot:${p.id}`) : undefined } }); return `Autopilot ${v ? "on" : "off"} for ${p.name}.`; })} /></label>
                </div>
                <div className="mt-2 text-xs text-muted-foreground">{last ? `Last scan ${new Date(last.created_at).toLocaleString()}: ${last.status === "done" ? `${last.findings.length} findings on ${last.pages_checked} pages` : last.status}` : "Not scanned yet"}</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {p.site_url
                    ? <button className={btn} disabled={!!busy} onClick={() => act(`s${p.id}`, async () => { const r = await scan({ data: { id: p.id } }); return `Scanned ${r.pages} pages: ${r.findings} findings.`; })}>{busy === `s${p.id}` ? "Scanning…" : "Scan now"}</button>
                    : <Link to="/project/$id" params={{ id: p.id }} className={btn}>Add site address to scan</Link>}
                  <button className={btn} disabled={!!busy} onClick={() => act(`c${p.id}`, async () => (await connect({ data: { id: p.id } })).steps.join(" · "))}>{busy === `c${p.id}` ? "Connecting…" : "Connect + scan + fix"}</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-silver">Scan reports</h2>
      <p className="mb-3 text-xs text-muted-foreground">Scans read each page's HTML and check links, load errors, speed, forms, mobile and accessibility basics. They don't run the site's JavaScript; runtime errors come from your projects' error reports.</p>
      {d.scans.length === 0 ? <p className="text-sm text-muted-foreground">No scans yet.</p> : (
        <ul className="space-y-3">
          {d.scans.slice(0, 10).map((s) => (
            <li key={s.id} className="panel p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold">{d.projects.find((p) => p.id === s.project_id)?.name} <span className="text-xs font-normal text-muted-foreground">· {new Date(s.created_at).toLocaleString()} · {s.pages_checked} pages · {s.links_checked} links{s.avg_ms !== null ? ` · avg ${s.avg_ms} ms` : ""}</span></div>
                {s.fix_proposal_id ? <Link to="/updates" className="text-xs text-electric underline">Fix written — view</Link> : s.status === "done" && s.findings.some((f) => f.severity !== "low") && (
                  <button className={btn} disabled={!!busy} onClick={() => act(`f${s.id}`, async () => (await fix({ data: { id: s.id } })).note)}>{busy === `f${s.id}` ? "Writing fix…" : "Write fix"}</button>
                )}
              </div>
              {s.error && <p className="text-xs text-destructive">{s.error}</p>}
              {s.findings.length === 0 && s.status === "done" ? <p className="mt-2 text-xs text-success">No problems found.</p> : (
                <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto text-xs">
                  {s.findings.map((f, i) => <li key={i}><span className={`font-semibold uppercase ${sev(f.severity)}`}>{f.severity}</span> {f.message} <span className="break-all text-muted-foreground">{f.url}</span></li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

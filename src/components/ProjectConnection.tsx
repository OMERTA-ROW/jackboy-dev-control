import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { StatusPill, btn, field, primaryBtn } from "@/components/ProjectBits";
import { connectProject, getProjectConnection } from "@/lib/project-connect.functions";
import { useStepUp } from "@/lib/step-up-client";
import { setDevEnabled } from "@/lib/project-hub.functions";
import { loopResult } from "@/lib/connect-select";
import { CheckCircle2 } from "lucide-react";
import { ProjectPermissionsPanel } from "@/components/ProjectPermissionsPanel";

type D = Awaited<ReturnType<typeof getProjectConnection>>;
const TONE = { connected: "ok", not_connected: "muted", needs_approval: "warn", verifying: "muted", blocked: "error" } as const;

/** The first-scan field comes back as JSON text (or "not run"/"error: …"); turn it into one plain line. */
function scanText(scan: string): string {
  try { return loopResult(JSON.parse(scan)).text; } catch { return scan; }
}

/** Real repo connection for one project: identity, verified permissions, Connect/Reconnect with passkey, evidence. */
export function ProjectConnection({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const load = useServerFn(getProjectConnection), connect = useServerFn(connectProject), setDev = useServerFn(setDevEnabled), stepUp = useStepUp();
  const [d, setD] = useState<D | null>(null);
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(""); const [err, setErr] = useState("");
  const refresh = useCallback(() => load({ data: { projectId } }).then((x) => { setD(x); setRepo((r) => r || x.project.github_repo || x.suggestion || ""); }).catch((e) => setErr((e as Error).message)), [load, projectId]);
  useEffect(() => { void refresh(); }, [refresh]);
  if (!d) return <section className="panel p-5 text-sm text-muted-foreground">{err || "Loading connection…"}</section>;
  const repoGrant = d.grants.find((g: { capability: string }) => g.capability === "github_repo") as { status: string; last_verified_at: string | null; account: string | null } | undefined;
  const meta = d.repos.find((r) => r.repo === d.project.github_repo);
  const connected = d.connection.state === "connected";
  const go = async () => {
    setBusy(true); setErr(""); setMsg("");
    try {
      const r = await stepUp("approve_integration", `github_repo:${projectId}`, {
        applyingText: `Checking access to ${repo} and running the first scan…`,
        apply: (grantId) => connect({ data: { projectId, repo, grantId } }),
        doneText: (x) => x.connected ? `Connected to ${repo}.` : `Not connected: ${x.detail}`,
      });
      setMsg(r.connected ? `Connected. ${r.detail} First scan: ${scanText(r.scan)}. Next: activate background work.` : `Not connected: ${r.detail}`);
      await refresh(); onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const background = async (on: boolean) => {
    setBusy(true); setErr(""); setMsg("");
    try {
      if (on) await stepUp("autonomy_toggle", `dev:${projectId}`, {
        applyingText: `Activating background work for ${d.project.name}…`,
        apply: (grantId) => setDev({ data: { id: projectId, enabled: true, grantId } }),
        doneText: () => `Background work is active for ${d.project.name}.`,
      });
      else await setDev({ data: { id: projectId, enabled: false } });
      setMsg(on ? "Background work is active." : "Background work is off.");
      await refresh(); onChanged();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const picker = (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1 text-sm">Repository Jackboy can write
        <select className={`${field} mt-1 w-full`} value={repo} onChange={(e) => setRepo(e.target.value)}>
          <option value="">Choose a repository…</option>
          {d.repos.map((r) => <option key={r.repo} value={r.repo}>{r.repo} ({r.visibility}{r.org ? `, ${r.org}` : ""}){r.repo === d.suggestion ? " — suggested" : ""}</option>)}
        </select>
      </label>
      <button type="button" className={connected ? btn : primaryBtn} disabled={busy || !repo} onClick={() => void go()}>{busy ? "Working…" : d.project.github_repo ? "Reconnect (passkey)" : "Connect (passkey)"}</button>
    </div>
  );
  return (
    <section className="panel p-5 lg:col-span-2" aria-labelledby="repo-conn">
      <div className="flex items-center justify-between gap-2">
        <h2 id="repo-conn" className="font-semibold">Code connection</h2>
        <StatusPill status={{ label: d.connection.label, tone: TONE[d.connection.state] }} />
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Project ID</dt><dd className="truncate font-mono text-xs">{d.project.id}</dd>
        <dt className="text-muted-foreground">Connection ID</dt><dd className="truncate font-mono text-xs">{d.connectionId ?? "None yet"}</dd>
        <dt className="text-muted-foreground">Repository</dt><dd className="truncate">{d.project.github_repo ?? "Not linked"}{meta ? ` · ${meta.visibility}${meta.org ? ` · org ${meta.org}` : ""}` : ""}</dd>
        <dt className="text-muted-foreground">GitHub account</dt><dd>{repoGrant?.account ?? "—"}</dd>
        <dt className="text-muted-foreground">Last verified</dt><dd>{repoGrant?.last_verified_at ? new Date(repoGrant.last_verified_at).toLocaleString() : "Never"}</dd>
      </dl>
      {d.reposError && <p className="mt-2 text-sm text-destructive">GitHub: {d.reposError}</p>}
      {d.project.github_repo && <div className="mt-4"><ProjectPermissionsPanel projectId={projectId} onChecked={() => void refresh()} /></div>}
      {connected ? (
        <>
          <p className="mt-3 flex items-center gap-2 text-sm text-success"><CheckCircle2 className="h-4 w-4" aria-hidden />Connected to {d.project.github_repo}. Nothing to reconnect.</p>
          <details className="mt-1 text-sm">
            <summary className="cursor-pointer text-xs text-muted-foreground">Change repository</summary>
            {picker}
          </details>
        </>
      ) : picker}
      {!d.repos.length && !d.reposError && !connected && <p className="mt-2 text-xs text-muted-foreground">No writable repositories are visible to the connected GitHub account.</p>}
      {!connected && <p className="mt-2 text-xs text-muted-foreground">Connecting runs a real check: read, create and delete a test branch, and read pull requests. Only if that passes is the first scan run. Background work stays off until you activate it.</p>}
      <div className="mt-4 rounded-md border border-border p-3" aria-live="polite">
        <h3 className="text-sm font-semibold">Background work</h3>
        {!connected ? <p className="mt-1 text-xs text-muted-foreground">Connect the repository first. Activation comes right after.</p>
          : d.project.dev_enabled ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 text-sm text-success"><CheckCircle2 className="h-4 w-4" aria-hidden />Active</span>
              <span className="text-xs text-muted-foreground">Routine scans and fixes run on their own; merges, deploys and new permissions still need you.</span>
              <button type="button" className={btn} disabled={busy} onClick={() => void background(false)}>Turn off background work</button>
            </div>
          ) : (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Next step: off until you activate it.</span>
              <button type="button" className={primaryBtn} disabled={busy} onClick={() => void background(true)}>Activate background work (passkey)</button>
            </div>
          )}
      </div>
      {msg && <p className="mt-2 break-words text-sm text-success" role="status">{msg}</p>}
      {err && <p className="mt-2 text-sm text-destructive" role="alert">{err}</p>}
      <h3 className="mt-4 text-sm font-semibold">Evidence</h3>
      {d.tasks.length === 0 && d.log.length === 0 ? <p className="text-sm text-muted-foreground">No recorded work yet.</p> : (
        <ul className="mt-1 space-y-1 text-sm">
          {d.tasks.map((t: { id: string; title: string; state: string; pr_url: string | null; blocked_reason: string | null }) => (
            <li key={t.id}><span className="font-medium">{t.title}</span> · {t.state}{t.pr_url ? <> · <a className="underline" href={t.pr_url} target="_blank" rel="noreferrer noopener">pull request</a></> : null}{t.blocked_reason ? <span className="block text-xs text-muted-foreground">{t.blocked_reason}</span> : null}</li>
          ))}
          {d.packages.map((p: { id: string; version: string; package_sha256: string }) => <li key={p.id} className="text-xs">Package {p.version} · sha256 {p.package_sha256.slice(0, 12)}…</li>)}
          {d.log.slice(0, 5).map((l: { id: string; at: string; status: string; summary: string }) => <li key={l.id} className="text-xs text-muted-foreground">{new Date(l.at).toLocaleString()} · {l.status} · {l.summary}</li>)}
        </ul>
      )}
      <Link to="/foundry" className={`${btn} mt-3 inline-flex`}>Open Code Foundry</Link>
    </section>
  );
}

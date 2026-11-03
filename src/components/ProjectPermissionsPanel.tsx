import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { verifyProjectPermissions } from "@/lib/project-permissions.functions";
import type { PermissionResult } from "@/lib/project-permissions";
export function ProjectPermissionsPanel({ projectId, onChecked }: { projectId?: string; onChecked?: () => void }) {
  const verify = useServerFn(verifyProjectPermissions);
  const [results, setResults] = useState<Awaited<ReturnType<typeof verifyProjectPermissions>>>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const run = async () => { setBusy(true); setError(""); try { setResults(await verify({ data: { projectId } })); window.dispatchEvent(new Event("jackboy:permissions-checked")); onChecked?.(); } catch (e) { setError(e instanceof Error ? e.message : "Verification failed"); } finally { setBusy(false); } };
  useEffect(() => { void run(); }, [projectId]);
  const item = (name: string, permission: PermissionResult) => <li key={name} className="py-1 [overflow-wrap:anywhere]"><strong>{name}: {permission.state}</strong><p className="text-xs text-muted-foreground">{permission.detail}</p></li>;
  return <section aria-labelledby={`permissions-${projectId ?? "all"}`} className="mb-4 border-b border-border pb-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 id={`permissions-${projectId ?? "all"}`} className="font-semibold">Live GitHub permissions</h2><Button variant="outline" disabled={busy} onClick={() => void run()}><RefreshCw />{busy ? "Checking GitHub…" : "Re-verify permissions"}</Button></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {results.map((r) => <div key={r.projectId} className="mt-3 text-sm">{r.error ? <p className="text-destructive">{r.error}</p> : r.evidence && <>
      <h3 className="font-semibold">{r.evidence.repo}</h3><p className="text-xs text-muted-foreground">Checked {new Date(r.evidence.checkedAt).toLocaleString()} · work uses {r.evidence.workerCredential} · GITHUB_TOKEN account: {r.evidence.tokenAccount ?? "not verified"}</p>
      <ul>{item("Contents read", r.evidence.contentsRead)}{item("Pull requests write", r.evidence.pullRequestsWrite)}{item("Actions read", r.evidence.actionsRead)}{item("Actions write", r.evidence.actionsWrite)}</ul>
      <details className="mt-2 text-xs"><summary>Current GITHUB_TOKEN checks</summary><ul>{Object.entries(r.evidence.tokenChecks).map(([name, p]) => item(name, p))}</ul></details>
      {!r.evidence.exists && <Link to="/settings" className="text-destructive underline">Repo not found / access unavailable — review proposed removal in Repository review</Link>}
      <a href="https://github.com/settings/personal-access-tokens" className="mr-3 text-xs text-primary underline" target="_blank" rel="noopener noreferrer">Token repository permissions</a><a href="https://github.com/organizations/OMERTA-ROW/settings/installations" className="text-xs text-primary underline" target="_blank" rel="noopener noreferrer">Organization App permissions</a>
    </>}</div>)}
  </section>;
}
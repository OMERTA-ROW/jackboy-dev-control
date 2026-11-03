import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStepUp } from "@/lib/step-up-client";
import { resyncRepositories, approveRepositoryResync } from "@/lib/repository-resync.functions";

export function RepositoryResyncPanel() {
  const scan = useServerFn(resyncRepositories), approve = useServerFn(approveRepositoryResync), stepUp = useStepUp();
  const [result, setResult] = useState<Awaited<ReturnType<typeof resyncRepositories>> | null>(null);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [fixed, setFixed] = useState<{ from: string; to: string }[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const run = async () => {
    setBusy(true); setError("");
    try { setResult(await scan()); setChoices({}); setFixed([]); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!result) return;
    setBusy(true); setError("");
    try {
      const grantId = await stepUp("approve_integration", `repository_resync:${result.id}`);
      const answer = await approve({ data: { reviewId: result.id, grantId, changes: Object.entries(choices).filter(([,to]) => !!to).map(([from,to]) => ({ from,to })) } });
      setFixed(answer.fixed); setChoices({});
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <section aria-labelledby="repository-resync" className="mb-6 border-b border-border pb-6">
    <h2 id="repository-resync" className="font-semibold">Repository links</h2>
    <Button variant="outline" className="mt-3" disabled={busy} onClick={run}><RefreshCw className={busy ? "animate-spin motion-reduce:animate-none" : ""} />{busy ? "Checking…" : "Resync repositories"}</Button>
    {error && <p role="alert" className="mt-3 break-words text-sm text-destructive">{error} <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener noreferrer" className="underline">Review token access on GitHub</a></p>}
    {result && <div className="mt-4 space-y-4 text-sm">
      <p>GITHUB_TOKEN · {result.login} · {result.inventory.length} accessible repositories · checked {new Date(result.checkedAt).toLocaleString()}</p>
      {!result.inventory.some(r => r.toLowerCase().startsWith("omerta-row/")) && <p className="text-warning">This token lists no OMERTA-ROW repositories. The GitHub App may have separate access; it was not used for this resync.</p>}
      <ul className="divide-y divide-border">{result.rows.map(row => {
        const applied = fixed.find(f => f.from === row.repo);
        const mutable = row.references.filter(r => r.mutable);
        return <li key={row.repo} className="py-3">
          <p className="break-words font-medium">{row.repo}</p>
          <p className={applied || row.status === "linked" ? "text-success" : "text-warning"}>{applied ? `Fixed → ${applied.to}` : row.status === "linked" ? "Linked · visible to this token (write access not tested)" : "Still missing · not listed by this token"}</p>
          <p className="text-xs text-muted-foreground">{mutable.length} current / unstarted references · {row.references.length-mutable.length} history or approval-bound references preserved</p>
          {!applied && row.status === "missing" && mutable.length > 0 && <label className="mt-2 block">Proposed replacement
            <select aria-label={`Replacement for ${row.repo}`} className="mt-1 block w-full max-w-xl rounded-md border border-input bg-background p-2 text-foreground" value={choices[row.repo] ?? ""} disabled={busy} onChange={e => setChoices(c => ({ ...c, [row.repo]: e.target.value }))}>
              <option value="">Keep unchanged</option>
              {row.candidates.length > 0 && <optgroup label="Closest names">{row.candidates.map(r => <option key={r} value={r}>{r}</option>)}</optgroup>}
              <optgroup label="Other accessible repositories">{result.inventory.filter(r => !row.candidates.includes(r)).map(r => <option key={r} value={r}>{r}</option>)}</optgroup>
            </select>
          </label>}
        </li>;
      })}</ul>
      {Object.values(choices).some(Boolean) && <div><p className="mb-2 text-warning">Approval replaces selected current references together. Development is disabled, unstarted tasks paused, and unsent jobs cancelled for fresh approval. History and existing approval scopes stay unchanged.</p><Button onClick={apply} disabled={busy}><Check />Approve selected replacements</Button></div>}
      {fixed.length > 0 && <p role="status" className="text-success">{fixed.length} repository replacement(s) saved. Reconnect and review affected work before resuming.</p>}
      <h3 className="font-medium">All repositories visible to this token</h3>
      <ul className="grid gap-1 text-xs md:grid-cols-2">{result.inventory.map(repo => <li key={repo} className="break-words"><a className="text-primary underline" href={`https://github.com/${repo}`} target="_blank" rel="noopener noreferrer">{repo}</a></li>)}</ul>
      <h3 className="font-medium">Separate owner review</h3>
      <ul className="space-y-2 text-xs text-muted-foreground">{result.manual.map(m => <li key={`${m.location}:${m.repo}`} className="break-words">{m.location} · {m.repo}: {m.reason}</li>)}<li>GitHub App inventory comes from GitHub, not name matching. Repository URLs in prior PRs, packages, research, logs and conversations remain historical evidence.</li></ul>
    </div>}
  </section>;
}
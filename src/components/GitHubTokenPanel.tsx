import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { verifyGithubToken } from "@/lib/github-token.functions";
import { btn } from "@/components/ProjectBits";

type Result = Awaited<ReturnType<typeof verifyGithubToken>>;
const Fix = ({ url }: { url: string }) => <a className="ml-1 underline text-primary" href={url} target="_blank" rel="noopener noreferrer">Fix on GitHub</a>;

export function GitHubTokenPanel() {
  const verify = useServerFn(verifyGithubToken);
  const [r, setR] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const run = async () => { setBusy(true); setErr(""); try { setR(await verify()); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  return (
    <section aria-labelledby="ghtoken" className="panel mb-6 p-4">
      <h2 id="ghtoken" className="font-semibold">GitHub token</h2>
      <p className="mt-1 text-sm text-muted-foreground">Jackboy reads your token only from the secure <code>GITHUB_TOKEN</code> backend secret. Never paste it into chat or any box in the app. To add or replace it: Project Settings → Secrets → <code>GITHUB_TOKEN</code>. Then press Verify.</p>
      <button className={`${btn} mt-3`} disabled={busy} onClick={run}>{busy ? "Checking with GitHub…" : "Verify token"}</button>
      {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
      {r && !r.configured && <p className="mt-2 text-sm text-destructive">No GITHUB_TOKEN secret is saved yet. Create a token<Fix url={r.fixUrl} />, then save it in Project Settings → Secrets.</p>}
      {r && r.configured && !r.valid && <p className="mt-2 text-sm text-destructive">{r.problem.reason}<Fix url={r.problem.fixUrl} /></p>}
      {r && r.configured && r.valid && (
        <div className="mt-3 space-y-2 text-sm">
          <p>Signed in to GitHub as <strong>{r.login}</strong> · {r.kind} token{r.expires ? ` · expires ${r.expires}` : ""}</p>
          <p className="text-muted-foreground">{r.kind === "classic" ? `Scopes: ${r.scopes || "none"}` : "Fine-grained token: GitHub doesn't list its permissions directly, so each repo below was tested for real."}</p>
          <p>OMERTA-ROW: {r.org.ok ? <span className="text-success">token accepted</span> : <span className="text-destructive">{r.org.problem?.reason}<Fix url={r.org.problem!.fixUrl} /></span>}</p>
          <ul className="space-y-1">
            {r.repos.map((x) => (
              <li key={x.repo}>
                <strong>{x.repo}</strong>{x.private !== null ? ` (${x.private ? "private" : "public"})` : ""}: read {x.read ? <span className="text-success">yes</span> : <span className="text-destructive">no</span>}, write {x.write === null ? "—" : x.write ? <span className="text-success">yes</span> : <span className="text-destructive">no</span>}
                {x.problem && <span className="block text-xs text-destructive">{x.problem.reason}<Fix url={x.problem.fixUrl} /></span>}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Write was tested by creating and deleting a throwaway branch. Checked {new Date(r.checkedAt).toLocaleString()}.</p>
        </div>
      )}
    </section>
  );
}

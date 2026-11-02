import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { githubAppStatus, startGithubAppManifest } from "@/lib/github-app-setup.functions";
import { PERMISSION_REASONS } from "@/lib/github-app-manifest";
import { btn } from "@/components/ProjectBits";

type Status = Awaited<ReturnType<typeof githubAppStatus>>;

export function GitHubAppPanel() {
  const status = useServerFn(githubAppStatus);
  const start = useServerFn(startGithubAppManifest);
  const [s, setS] = useState<Status | null>(null);
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const load = () => status().then(setS).catch((e) => setErr((e as Error).message));
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("github_app") === "created") setNote(`App ${q.get("slug")} created and saved securely. Now install it (step 2).`);
    if (q.get("github_app") === "error") setErr(q.get("reason") ?? "Setup failed.");
    void load();
  }, []);

  const create = async () => {
    setBusy(true); setErr("");
    try {
      const r = await start({ data: { org: "OMERTA-ROW", origin: window.location.origin } });
      const f = document.createElement("form");
      f.method = "post"; f.action = r.action;
      const i = document.createElement("input"); i.type = "hidden"; i.name = "manifest"; i.value = r.manifest;
      f.appendChild(i); document.body.appendChild(f); f.submit();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <section id="github-app" aria-labelledby="ghapp" className="panel mb-6 p-4">
      <h2 id="ghapp" className="font-semibold">Jackboy GitHub App</h2>
      <p className="mt-1 text-sm text-muted-foreground">A safer replacement for your personal token: short-lived keys, only the repos you pick, and you can remove it anytime on GitHub.</p>
      {note && <p className="mt-2 text-sm text-success">{note}</p>}
      {err && <p className="mt-2 text-sm text-destructive">{err}</p>}

      <ol className="mt-3 space-y-4 text-sm">
        <li>
          <strong>1. Create the app</strong> {s?.created && <span className="text-success">— done ({s.slug}{s.source === "manifest" ? ", saved encrypted" : ", from Project Secrets"})</span>}
          {!s?.created && (
            <>
              <p className="mt-1 text-muted-foreground">Click the button, check the page GitHub shows, then click <em>Create GitHub App for OMERTA-ROW</em>. You'll come straight back here. Use the published site, not the editor preview.</p>
              <details className="mt-2"><summary className="cursor-pointer">What it asks for, and why</summary>
                <ul className="mt-2 space-y-1">
                  {PERMISSION_REASONS.map((p) => <li key={p.name}><strong>{p.name}</strong> ({p.level}): {p.why}</li>)}
                </ul>
              </details>
              <button className={`${btn} mt-2`} disabled={busy || !s} onClick={create}>{busy ? "Opening GitHub…" : "Create Jackboy GitHub App"}</button>
            </>
          )}
        </li>
        <li>
          <strong>2. Install it and pick repos</strong>
          {s?.installUrl ? (
            <p className="mt-1">
              <a className={btn} href={s.installUrl} target="_blank" rel="noopener noreferrer">Install on GitHub</a>
              <span className="ml-2 text-muted-foreground">Choose OMERTA-ROW → "Only select repositories" → pick Omni and orbiting-minds-mothership → Install. Repeat for street-Tech666 if you want Jackboy's own repo and Honeycomb Terminal covered.</span>
            </p>
          ) : <p className="mt-1 text-muted-foreground">Available after step 1.</p>}
          {s?.installations.map((i) => (
            <p key={i.account} className="mt-1">{i.account}: {i.repos.length} repo(s){i.missing.length ? <span className="text-destructive"> · missing {i.missing.join(", ")}</span> : <span className="text-success"> · permissions OK</span>}</p>
          ))}
        </li>
        <li>
          <strong>3. Switch from your personal token</strong>
          <p className="mt-1 text-muted-foreground">Automatic: any repo covered by the app uses it. Your personal token is only a backup for repos not yet installed. Once everything below says "app", you can delete GITHUB_TOKEN in Project Settings → Secrets.</p>
          <ul className="mt-1 space-y-0.5">
            {s?.repos.map((r) => <li key={r.repo}>{r.name} ({r.repo}): <span className={r.via === "app" ? "text-success" : r.via === "none" ? "text-destructive" : ""}>{r.via}</span></li>)}
          </ul>
          <button className={`${btn} mt-2`} onClick={() => void load()}>Refresh</button>
        </li>
      </ol>
    </section>
  );
}

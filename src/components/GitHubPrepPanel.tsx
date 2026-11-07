import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ExternalLink, GitPullRequest, CircleDot } from "lucide-react";
import {
  createGitHubIssue,
  getGitHubPrepStatus,
  openGitHubDraftPr,
  previewGitHubDraftPr,
  previewGitHubIssue,
} from "@/lib/github-prep.functions";
import { ciLabel, reviewLabel, type CiSummary } from "@/lib/github-prep";
import { btn, field, primaryBtn } from "@/components/ProjectBits";

type Status = Awaited<ReturnType<typeof getGitHubPrepStatus>>;
type Draft = { title: string; body: string; ci: CiSummary | null };

const ciTone = (s: CiSummary["state"]) =>
  s === "passed" ? "text-success" : s === "failed" ? "text-destructive" : "text-warning";

/** Prepare GitHub issues and draft pull requests with live CI evidence and review status.
 * Two writes only (open issue, open draft PR), both pressed by the owner. No merge or deploy. */
export function GitHubPrepPanel({ projectId }: { projectId: string }) {
  const load = useServerFn(getGitHubPrepStatus);
  const prevIssue = useServerFn(previewGitHubIssue);
  const mkIssue = useServerFn(createGitHubIssue);
  const prevPr = useServerFn(previewGitHubDraftPr);
  const mkPr = useServerFn(openGitHubDraftPr);
  const [s, setS] = useState<Status | null>(null);
  const [mode, setMode] = useState<"issue" | "pr">("issue");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [branch, setBranch] = useState("jackboy/");
  const [issueNo, setIssueNo] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  const refresh = useCallback(
    () => load({ data: { projectId } }).then(setS).catch((e: Error) => setMsg({ ok: false, text: e.message })),
    [load, projectId],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      await work();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const prInput = () => ({
    projectId, branch: branch.trim(), title, summary: text,
    issueNumber: issueNo ? Number(issueNo) : null,
  });

  return (
    <section className="panel mt-4 p-5 text-sm" aria-labelledby="gh-prep">
      <h2 id="gh-prep" className="font-semibold">GitHub issues &amp; pull requests</h2>
      <p className="mt-1 text-muted-foreground">
        Jackboy can open an issue or a <strong>draft</strong> pull request from its own <code>jackboy/</code> branches,
        with CI results and review status read live from GitHub. It can't merge, approve, mark ready or deploy —
        those stay with you in GitHub.
      </p>

      {s?.error && <p role="alert" className="mt-2 text-destructive">GitHub: {s.error}</p>}
      {s?.baseCi && (
        <p className="mt-2 text-xs">
          <span className="text-muted-foreground">{s.repo} · {s.base}: </span>
          <span className={ciTone(s.baseCi.state)}>{ciLabel(s.baseCi.state)}</span>
          <span className="text-muted-foreground"> ({s.baseCi.passed} passed, {s.baseCi.failed} failed, {s.baseCi.running} running)</span>
        </p>
      )}

      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wider text-silver">Open pull requests</h3>
      {s && !s.error && s.pulls.length === 0 && <p className="mt-1 text-muted-foreground">No open pull requests.</p>}
      <ul className="mt-2 space-y-2">
        {s?.pulls.map((p) => (
          <li key={p.number} className="rounded-md border border-border p-3">
            <a href={p.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-electric underline">
              #{p.number} {p.title} <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
            <p className="mt-1 text-xs text-muted-foreground">{p.branch}{p.author ? ` · by ${p.author}` : ""}</p>
            <p className="mt-1 text-xs">
              <span className={ciTone(p.ci.state)}>{ciLabel(p.ci.state)}</span>
              {" · "}
              <span className={p.review.state === "approved" ? "text-success" : p.review.state === "changes_requested" ? "text-destructive" : "text-warning"}>
                {reviewLabel(p.review.state)}
              </span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{p.line}</p>
            {p.ci.items.some((i) => i.result === "failed") && (
              <ul className="mt-1 text-xs text-destructive">
                {p.ci.items.filter((i) => i.result === "failed").slice(0, 5).map((i) => (
                  <li key={i.name}>{i.url ? <a className="underline" href={i.url} target="_blank" rel="noreferrer">{i.name}</a> : i.name} failed</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      <h3 className="mt-5 text-xs font-semibold uppercase tracking-wider text-silver">Prepare</h3>
      <div className="mt-2 flex gap-2" role="tablist">
        {(["issue", "pr"] as const).map((m) => (
          <button key={m} role="tab" aria-selected={mode === m} className={mode === m ? primaryBtn : btn} onClick={() => { setMode(m); setDraft(null); }}>
            {m === "issue" ? <><CircleDot className="mr-1 inline h-3.5 w-3.5" aria-hidden />Issue</> : <><GitPullRequest className="mr-1 inline h-3.5 w-3.5" aria-hidden />Draft pull request</>}
          </button>
        ))}
      </div>
      <div className="mt-3 space-y-2">
        <input className={field} aria-label="Title" placeholder="Title" value={title} onChange={(e) => { setTitle(e.target.value); setDraft(null); }} />
        {mode === "pr" && (
          <div className="grid gap-2 sm:grid-cols-[1fr_140px]">
            <input className={field} aria-label="Branch" placeholder="jackboy/…" value={branch} onChange={(e) => { setBranch(e.target.value); setDraft(null); }} />
            <input className={field} aria-label="Related issue number" placeholder="Issue # (optional)" inputMode="numeric" value={issueNo} onChange={(e) => { setIssueNo(e.target.value.replace(/\D/g, "")); setDraft(null); }} />
          </div>
        )}
        <textarea className={field} rows={4} aria-label={mode === "issue" ? "What's wrong" : "Summary"} placeholder={mode === "issue" ? "What's wrong, and how to see it" : "What this change does and why"} value={text} onChange={(e) => { setText(e.target.value); setDraft(null); }} />
        <button
          className={btn}
          disabled={busy || !title.trim() || !text.trim()}
          onClick={() =>
            void run(async () => {
              setDraft(mode === "issue" ? await prevIssue({ data: { projectId, title, problem: text } }) : await prevPr({ data: prInput() }));
            })
          }
        >
          {busy && !draft ? "Reading GitHub…" : "Preview with CI evidence"}
        </button>
      </div>

      {draft && (
        <div className="mt-3 space-y-2 rounded-md border border-border p-3">
          <p className="font-medium">{draft.title}</p>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{draft.body}</pre>
          <button
            className={primaryBtn}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = mode === "issue"
                  ? await mkIssue({ data: { projectId, title, problem: text, confirm: true } })
                  : await mkPr({ data: { ...prInput(), confirm: true } });
                setDraft(null);
                setMsg({ ok: true, text: mode === "issue" ? `Issue #${r.number} opened.` : `Draft pull request #${r.number} opened. Merge it yourself in GitHub if you agree.`, url: r.url });
                void refresh();
              })
            }
          >
            {mode === "issue" ? "Open this issue on GitHub" : "Open as draft pull request"}
          </button>
        </div>
      )}

      {msg && (
        <p role="status" className={`mt-3 ${msg.ok ? "text-success" : "text-destructive"}`}>
          {msg.text}{" "}
          {msg.url && <a className="underline" href={msg.url} target="_blank" rel="noreferrer">View on GitHub</a>}
        </p>
      )}
    </section>
  );
}

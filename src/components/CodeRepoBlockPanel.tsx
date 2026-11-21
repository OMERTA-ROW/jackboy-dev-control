import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { btn, primaryBtn } from "@/components/ProjectBits";
import { useStepUp } from "@/lib/step-up-client";
import { codeRepoBlockTarget, listCodeRepoBlocks, setCodeRepoBlock } from "@/lib/code-repo-block.functions";

type Row = { repo: string; reason: string; created_at: string };

/** Settings: CODE covers every OMERTA-ROW repository; the owner can exclude some (fresh passkey). */
export function CodeRepoBlockPanel() {
  const list = useServerFn(listCodeRepoBlocks), set = useServerFn(setCodeRepoBlock);
  const stepUp = useStepUp();
  const [rows, setRows] = useState<Row[]>([]);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(async () => { try { setRows(await list()); } catch (e) { setMsg((e as Error).message); } }, [list]);
  useEffect(() => { void load(); }, [load]);
  const change = async (repo: string, blocked: boolean) => {
    setMsg(null);
    try {
      await stepUp("code_repo_block", codeRepoBlockTarget(repo, blocked), { applyingText: blocked ? "Blocking…" : "Unblocking…", apply: (grantId) => set({ data: { repo, blocked, reason: "", grantId } }), doneText: () => (blocked ? "Blocked." : "Unblocked.") });
      setName("");
    } catch (e) { setMsg((e as Error).message); } finally { void load(); }
  };
  const repo = `OMERTA-ROW/${name.trim()}`;
  return (
    <section id="code-repos" className="panel mb-4 p-4" aria-labelledby="code-repos-h">
      <h2 id="code-repos-h" className="text-sm font-semibold uppercase tracking-wider text-silver">CODE repositories</h2>
      <p className="mt-1 text-xs text-muted-foreground">CODE can work on every OMERTA-ROW repository, including new ones, through the one Jackboy workflow. Every run still needs your approval, opens a draft PR only, and shares the same spending limits. Block a repository to exclude it.</p>
      <ul className="mt-3 space-y-2 text-sm">
        {rows.length === 0 && <li className="text-xs text-muted-foreground">No repositories blocked.</li>}
        {rows.map((r) => (
          <li key={r.repo} className="flex items-center justify-between gap-2 rounded-md border border-border p-2">
            <span>{r.repo}</span>
            <button type="button" className={btn} onClick={() => void change(r.repo, false)}>Unblock</button>
          </li>
        ))}
      </ul>
      <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void change(repo, true); }}>
        <label htmlFor="block-repo" className="text-xs text-muted-foreground">OMERTA-ROW/</label>
        <input id="block-repo" value={name} onChange={(e) => setName(e.target.value)} pattern="[A-Za-z0-9._\-]{1,100}" className="rounded-md border border-border bg-background px-2 py-1 text-sm" placeholder="repository-name" />
        <button type="submit" className={primaryBtn} disabled={!name.trim()}>Block with passkey</button>
      </form>
      {msg && <p className="mt-2 text-xs text-destructive">{msg}</p>}
    </section>
  );
}

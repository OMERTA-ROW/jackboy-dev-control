import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { RefreshCw } from "lucide-react";
import { btn } from "@/components/ProjectBits";
import { archiveGoneProject, resyncProject } from "@/lib/project-resync.functions";

type P = { id: string; name: string; github_repo: string | null; repo_sync_status?: string };

/** Small corner icon: re-identifies just this project (repo, name, site address, credential). */
export function ProjectResyncIcon({ p, onDone }: { p: P; onDone: (msg: string, gone: boolean) => void }) {
  const resync = useServerFn(resyncProject);
  const [busy, setBusy] = useState(false);
  return <button type="button" className="rounded-md p-1 text-muted-foreground hover:text-electric disabled:opacity-50" title={`Resync ${p.name}`} aria-label={`Resync ${p.name}`} disabled={busy}
    onClick={async () => {
      setBusy(true);
      try {
        const r = await resync({ data: { id: p.id } });
        onDone(`${r.name}: ${r.changes.length ? r.changes.join("; ") : "up to date"} · repo ${r.repo ?? "not linked"} · covered by ${r.credential}${r.notes.length ? ` · ${r.notes.join(" ")}` : ""}`, r.repoState === "gone");
      } catch (e) { onDone(`${p.name}: resync failed — ${(e as Error).message}`, false); }
      finally { setBusy(false); }
    }}><RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} aria-hidden /></button>;
}

/** Connect/Reconnect opens the project's connection section; Remove appears only when GitHub reported the repo gone. */
export function ProjectConnectButtons({ p, gone, onRemoved }: { p: P; gone: boolean; onRemoved: (msg: string) => void }) {
  const archive = useServerFn(archiveGoneProject);
  const [busy, setBusy] = useState(false);
  return <>
    <Link to="/project/$id" params={{ id: p.id }} hash="repo-conn" className={btn}>{p.github_repo ? "Reconnect" : "Connect"}</Link>
    {(gone || p.repo_sync_status === "deleted") && <button type="button" className={btn} disabled={busy} onClick={async () => {
      if (!window.confirm(`Remove ${p.name} from your projects? GitHub reports its repo is gone. History and logs are kept, and you can restore it.`)) return;
      setBusy(true);
      try { await archive({ data: { id: p.id } }); onRemoved(`${p.name} removed from Projects. History kept.`); }
      catch (e) { onRemoved((e as Error).message); }
      finally { setBusy(false); }
    }}>{busy ? "Removing…" : "Remove (repo gone)"}</button>}
  </>;
}

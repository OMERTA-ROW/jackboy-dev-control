import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, RefreshCw } from "lucide-react";
import { btn } from "@/components/ProjectBits";
import { cn } from "@/lib/utils";
import { archiveGoneProject, resyncProject } from "@/lib/project-resync.functions";
import { setSiteAddress } from "@/lib/project-hub.functions";
import { connectButtonLabel, normalizeSiteInput } from "@/lib/project-hub";

type P = { id: string; name: string; github_repo: string | null; repo_sync_status?: string; connect_state?: string | null; connect_error?: string | null };

/** Small corner icon: re-identifies just this project (repo, name, site address, credential). */
export function ProjectResyncIcon({ p, onDone }: { p: P; onDone: (msg: string, gone: boolean) => void }) {
  const resync = useServerFn(resyncProject);
  const [busy, setBusy] = useState(false);
  return <button type="button" className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-full p-1 text-muted-foreground hover:text-electric disabled:opacity-50" title={`Recheck ${p.name}`} aria-label={`Recheck and reconnect ${p.name}`} disabled={busy}
    onClick={async () => {
      setBusy(true);
      try {
        const r = await resync({ data: { id: p.id } });
        const access = r.repoAccess ? ` · access: ${r.repoAccess}` : r.repoError ? ` · access check failed: ${r.repoError}` : "";
        const site = r.site ? ` · site: ${r.site}` : "";
        onDone(`${r.name}: ${r.repoState === "gone" ? "repo gone" : r.changes.length ? r.changes.join("; ") : "up to date"} · repo ${r.repo ?? "not linked"} · covered by ${r.credential}${access}${site}${r.notes.length ? ` · ${r.notes.join(" ")}` : ""}`, r.repoState === "gone");
      } catch (e) { onDone(`${p.name}: resync failed — ${(e as Error).message}`, false); }
      finally { setBusy(false); }
    }}><RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} aria-hidden /></button>;
}

/** Connect / Connected / Reconnect follows the real connection; Remove appears only when GitHub reported the repo gone. */
export function ProjectConnectButtons({ p, gone, tone, onRemoved }: { p: P; gone: boolean; tone?: "ok" | "warn" | "error" | "muted"; onRemoved: (msg: string) => void }) {
  const archive = useServerFn(archiveGoneProject);
  const [busy, setBusy] = useState(false);
  const label = gone ? "Reconnect" : connectButtonLabel(p, tone);
  return <>
    {label === "Connected"
      ? <Link to="/project/$id" params={{ id: p.id }} hash="repo-conn" className={cn(btn, "gap-1 border-success/40 text-success")} aria-label={`${p.name} is connected to ${p.github_repo}. Open connection details`}><CheckCircle2 className="h-4 w-4" aria-hidden />Connected</Link>
      : <Link to="/project/$id" params={{ id: p.id }} hash="repo-conn" className={btn} aria-label={`${label} a GitHub repo for ${p.name}`}>{label}</Link>}
    {(gone || p.repo_sync_status === "deleted") && <button type="button" className={btn} disabled={busy} onClick={async () => {
      if (!window.confirm(`Remove ${p.name} from your projects? GitHub reports its repo is gone. History and logs are kept, and you can restore it.`)) return;
      setBusy(true);
      try { await archive({ data: { id: p.id } }); onRemoved(`${p.name} removed from Projects. History kept.`); }
      catch (e) { onRemoved((e as Error).message); }
      finally { setBusy(false); }
    }}>{busy ? "Removing…" : "Remove (repo gone)"}</button>}
  </>;
}

/** Inline site address editor: saves to the backend, then shows the real site check result. Shown on every project; prefills the current address when one exists. */
export function AddSiteButton({ p, onSaved }: { p: { id: string; name: string; site_url?: string | null }; onSaved: (msg: string) => void }) {
  const save = useServerFn(setSiteAddress);
  const [open, setOpen] = useState(false), [v, setV] = useState(""), [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  if (!open) return <button type="button" className={btn} onClick={() => { setV(p.site_url ?? ""); setOpen(true); }}>Add site</button>;
  return <form className="flex w-full flex-wrap items-center gap-2 sm:w-auto" onSubmit={async (e) => {
    e.preventDefault(); setErr(null);
    if (!normalizeSiteInput(v)) { setErr("Enter a public https:// address."); return; }
    setBusy(true);
    try { const r = await save({ data: { id: p.id, url: v } }); setOpen(false); setV(""); onSaved(`${p.name}: site saved (${r.url}) · check: ${r.status}${r.reason ? ` — ${r.reason}` : ""}`); }
    catch (e2) { setErr((e2 as Error).message); }
    finally { setBusy(false); }
  }}>
    <label className="sr-only" htmlFor={`site-${p.id}`}>Site address for {p.name}</label>
    <input id={`site-${p.id}`} autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="https://example.com" inputMode="url" className="min-h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm sm:w-56" />
    <button type="submit" className={btn} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
    <button type="button" className={btn} disabled={busy} onClick={() => { setOpen(false); setErr(null); }}>Cancel</button>
    {err && <span role="alert" className="w-full text-xs text-destructive">{err}</span>}
  </form>;
}

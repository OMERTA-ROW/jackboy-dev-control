import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, Copy, ExternalLink, Loader2, RefreshCw, XCircle } from "lucide-react";
import { btn, primaryBtn } from "@/components/ProjectBits";
import { useStepUp } from "@/lib/step-up-client";
import { siteAddTarget, siteRemoveTarget, type CheckItem } from "@/lib/code-onboarding";
import { activateCodeSite, getCodeSite, listCodeSites, prepareCodeSite, removeCodeSite } from "@/lib/code-onboarding.functions";

type Status = Awaited<ReturnType<typeof getCodeSite>>;
const ICON: Record<CheckItem["status"], React.ReactNode> = {
  done: <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />,
  waiting: <CircleDashed className="h-4 w-4 shrink-0 text-warning" aria-hidden />,
  blocked: <XCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden />,
};
const WORD: Record<CheckItem["status"], string> = { done: "Done", waiting: "Waiting for you", blocked: "Blocked" };
const PHASE: Record<Status["phase"], string> = { not_started: "Not on CODE", prepared: "Prepared — waiting for you", ready: "Ready for your passkey", active: "On CODE", blocked: "Blocked" };

function CopyBox({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">{label}</span>
        <button type="button" className="inline-flex items-center gap-1 text-xs text-electric underline" onClick={() => void navigator.clipboard.writeText(value).then(() => { setDone(true); window.setTimeout(() => setDone(false), 1500); })}><Copy className="h-3 w-3" aria-hidden />{done ? "Copied" : "Copy"}</button></div>
      <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 text-xs break-all whitespace-pre-wrap">{value}</pre>
    </div>
  );
}

/** Project page: "Add to CODE" — prepare (draft PR), checklist, passkey activation and removal. */
export function CodeSiteCard({ projectId }: { projectId: string }) {
  const get = useServerFn(getCodeSite), prepare = useServerFn(prepareCodeSite), activate = useServerFn(activateCodeSite), remove = useServerFn(removeCodeSite);
  const stepUp = useStepUp();
  const [s, setS] = useState<Status | null>(null);
  const [busy, setBusy] = useState<"check" | "prepare" | "pin" | "remove" | null>("check");
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "error" | "info" } | null>(null);

  const check = useCallback(async () => {
    setBusy("check");
    try { setS(await get({ data: { projectId } })); } catch (e) { setMsg({ text: (e as Error).message, tone: "error" }); }
    finally { setBusy(null); }
  }, [get, projectId]);
  useEffect(() => { void check(); }, [check]);

  const onPrepare = async () => {
    setBusy("prepare"); setMsg({ text: "Preparing: writing the approved files to a jackboy branch and opening a draft PR…", tone: "info" });
    try {
      const r = await prepare({ data: { projectId } });
      setS(r.status);
      setMsg({ text: [r.pr ? `Draft PR #${r.pr.number} ${r.pr.existed ? "is up to date" : "opened"}.` : "", ...r.notes].filter(Boolean).join(" ") || "Prepared.", tone: "ok" });
    } catch (e) { setMsg({ text: (e as Error).message, tone: "error" }); }
    finally { setBusy(null); }
  };
  const onActivate = async () => {
    if (!s?.workflowSha) return;
    setBusy("pin"); setMsg(null);
    try {
      await stepUp("code_site_pin", siteAddTarget(s.repo, s.workflowSha), {
        applyingText: `Re-checking every gate and pinning ${s.repo}…`,
        apply: (grantId) => activate({ data: { projectId, grantId, workflowSha: s.workflowSha! } }),
        doneText: () => `${s.name} is on the CODE allow list. Each run still needs your approval in GitHub.`,
      });
      setMsg({ text: `${s.name} is on CODE. Each run still needs your approval in GitHub.`, tone: "ok" });
    } catch (e) { setMsg({ text: (e as Error).message, tone: "error" }); }
    finally { setBusy(null); void check(); }
  };
  const onRemove = async () => {
    if (!s) return;
    setBusy("remove"); setMsg(null);
    try {
      await stepUp("code_site_pin", siteRemoveTarget(s.repo), {
        applyingText: `Removing ${s.repo} from the CODE allow list…`,
        apply: (grantId) => remove({ data: { projectId, grantId } }),
        doneText: () => `${s.name} is off the CODE allow list.`,
      });
      setMsg({ text: `${s.name} is off CODE. You can also remove it from CODE_TARGETS (value below).`, tone: "ok" });
    } catch (e) { setMsg({ text: (e as Error).message, tone: "error" }); }
    finally { setBusy(null); void check(); }
  };

  const ready = s && !s.blockReason && s.phase !== "active";
  const tone = s?.phase === "active" ? "text-success" : s?.phase === "blocked" ? "text-destructive" : s?.phase === "ready" ? "text-electric" : "text-warning";
  return (
    <section className="panel p-5 lg:col-span-2" aria-labelledby="code-site">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="code-site" className="font-semibold">Add to CODE</h2>
          <p className="text-xs text-muted-foreground">Lets Jackboy CODE work on this repository. Nothing goes on the allow list without your passkey; every run still needs your approval in GitHub.</p>
        </div>
        {s && <span className={`text-xs font-semibold uppercase ${tone}`} aria-live="polite">{PHASE[s.phase]}</span>}
      </div>

      {!s && busy === "check" && <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Checking this repository…</p>}
      {s?.anchor && <p className="mt-3 text-sm text-muted-foreground">This is the Jackboy anchor site. Its CODE pin is managed in Settings → Autonomous Activation.</p>}

      {s && !s.anchor && (
        <>
          <p className="mt-2 text-xs text-muted-foreground">{s.repo}{s.profile ? ` · ${s.profile}` : ""}{s.workflowSha ? ` · workflow ${s.workflowSha.slice(0, 12)}…` : ""} · checked {new Date(s.checkedAt).toLocaleTimeString()}</p>
          <ol className="mt-3 space-y-2" aria-label="CODE checklist">
            {s.items.map((i) => (
              <li key={i.id} className="flex gap-2 text-sm">
                {ICON[i.status]}
                <div className="min-w-0">
                  <p><span className="font-medium">{i.label}</span> <span className="text-xs text-muted-foreground">· {WORD[i.status]}</span></p>
                  <p className="text-xs text-muted-foreground">{i.detail}</p>
                  {i.status !== "done" && i.fix && <p className="text-xs text-electric">{i.fix}</p>}
                </div>
              </li>
            ))}
          </ol>

          {s.pr && <a className="mt-3 inline-flex items-center gap-1 text-xs text-electric underline" href={s.pr.url} target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3" aria-hidden />Onboarding PR #{s.pr.number} ({s.pr.state})</a>}
          {s.workflowFile && (
            <div className="mt-3 rounded-md border border-warning/50 p-3">
              <p className="text-xs">GitHub didn't let the App add the workflow file. Add it to the <code>jackboy/code-onboarding</code> branch yourself with exactly this content, then press Prepare again.</p>
              <a className="mt-1 inline-flex items-center gap-1 text-xs text-electric underline" href={s.workflowFile.addUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3" aria-hidden />Create {s.workflowFile.path} on that branch</a>
              <CopyBox label={s.workflowFile.path} value={s.workflowFile.content} />
            </div>
          )}
          {s.phase !== "active" && s.codeTargetsValue && s.items.find((i) => i.id === "targets")?.status !== "done" && (
            <CopyBox label="CODE_TARGETS — exact value to save (keeps your existing sites)" value={s.codeTargetsValue} />
          )}
          {s.phase === "active" && <details className="mt-2"><summary className="cursor-pointer text-xs">CODE_TARGETS value without this site</summary><CopyBox label="CODE_TARGETS after removal" value={s.codeTargetsAfterRemoval} /></details>}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {s.phase !== "active" && s.phase !== "blocked" && <button type="button" className={s.phase === "not_started" ? primaryBtn : btn} disabled={!!busy} onClick={onPrepare}>{busy === "prepare" ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Preparing…</> : s.pr?.state === "open" ? "Update the PR" : "Prepare (open draft PR)"}</button>}
            <button type="button" className={btn} disabled={!!busy} onClick={() => void check()}>{busy === "check" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}Re-check</button>
            {s.phase !== "active" && <button type="button" className={primaryBtn} disabled={!!busy || !ready} title={s.blockReason ?? undefined} onClick={onActivate}>{busy === "pin" ? "Activating…" : "Approve and activate with passkey"}</button>}
            {s.phase === "active" && <button type="button" className={btn} disabled={!!busy} onClick={onRemove}>{busy === "remove" ? "Removing…" : "Remove from CODE (passkey)"}</button>}
          </div>
          {s.blockReason && s.phase !== "active" && <p className="mt-2 text-xs text-muted-foreground">Next: {s.blockReason}</p>}
        </>
      )}
      {msg && <p role="status" className={`mt-3 text-sm ${msg.tone === "error" ? "text-destructive" : msg.tone === "ok" ? "text-success" : "text-muted-foreground"}`}>{msg.text}</p>}
    </section>
  );
}

/** Settings: which sites CODE may work on, from the database pin and the saved CODE_TARGETS setting. */
export function CodeSitesList() {
  const list = useServerFn(listCodeSites);
  const [rows, setRows] = useState<Awaited<ReturnType<typeof listCodeSites>> | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { list().then(setRows).catch((e) => setErr((e as Error).message)); }, [list]);
  return (
    <section className="panel mb-4 p-4" aria-labelledby="code-sites">
      <h2 id="code-sites" className="text-sm font-semibold uppercase tracking-wider text-silver">CODE sites</h2>
      <p className="mt-1 text-xs text-muted-foreground">A site is usable only when your passkey-approved pin and the saved CODE_TARGETS setting agree. Add a site from its project page.</p>
      {err && <p className="mt-2 text-sm text-destructive">{err}</p>}
      {!rows && !err && <p className="mt-2 text-sm text-muted-foreground">Loading…</p>}
      {rows && (
        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          {rows.map((r) => (
            <li key={r.projectId} className="flex items-center justify-between gap-2 text-sm">
              <Link to="/project/$id" params={{ id: r.projectId }} className="truncate text-electric underline">{r.name}</Link>
              <span className={`shrink-0 text-xs ${r.usable ? "text-success" : r.pinned ? "text-warning" : "text-muted-foreground"}`}>{r.usable ? (r.anchor ? "On CODE · anchor" : "On CODE") : r.pinned ? "Pinned · CODE_TARGETS differs" : "Not on CODE"}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

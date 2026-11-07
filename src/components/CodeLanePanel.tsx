import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, Loader2, RefreshCw, XCircle } from "lucide-react";
import { btn, primaryBtn } from "@/components/ProjectBits";
import { useStepUp } from "@/lib/step-up-client";
import { autoLaneTarget, AUTO_MAX_FILES, AUTO_MAX_LINES, AUTO_RUNS_PER_SITE_PER_DAY } from "@/lib/code-lane";
import { getCodeLaneStatus, setCodeAutoLane } from "@/lib/code-lane.functions";

type Status = Awaited<ReturnType<typeof getCodeLaneStatus>>;

/** Settings: CODE approval lanes. Read-only checks, the trial log, and a per-site switch (fresh passkey, off by default). */
export function CodeLanePanel() {
  const get = useServerFn(getCodeLaneStatus), set = useServerFn(setCodeAutoLane);
  const stepUp = useStepUp();
  const [s, setS] = useState<Status | null>(null);
  const [busy, setBusy] = useState<string | null>("load");
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const load = useCallback(async () => {
    setBusy("load");
    try { setS(await get()); } catch (e) { setMsg({ text: (e as Error).message, tone: "error" }); } finally { setBusy(null); }
  }, [get]);
  useEffect(() => { void load(); }, [load]);

  const toggle = async (repo: string, on: boolean) => {
    setBusy(repo); setMsg(null);
    try {
      await stepUp("code_auto_lane", autoLaneTarget(repo, on), { applyingText: on ? "Checking every rule and turning the automatic lane on…" : "Turning the automatic lane off…", apply: (grantId) => set({ data: { repo, on, grantId } }), doneText: () => (on ? "Automatic lane on." : "Automatic lane off.") });
      setMsg({ text: `Automatic lane ${on ? "on" : "off"} for ${repo}.`, tone: "ok" });
    } catch (e) { setMsg({ text: (e as Error).message, tone: "error" }); } finally { setBusy(null); void load(); }
  };

  const yes = s?.trials.filter((t) => t.wouldAuto).length ?? 0;
  return (
    <section id="code-lanes" className="panel mb-4 p-4" aria-labelledby="code-lanes-h">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="code-lanes-h" className="text-sm font-semibold uppercase tracking-wider text-silver">CODE approval lanes</h2>
          <p className="mt-1 text-xs text-muted-foreground">Reviewed lane: every run waits for your GitHub approval (today). Automatic lane: small low-risk runs (at most {AUTO_MAX_FILES} files and {AUTO_MAX_LINES} lines, no protected files, $1 hold, {AUTO_RUNS_PER_SITE_PER_DAY} per site per day) start and open a draft PR without a click. Merging always needs you.</p>
        </div>
        <button type="button" className={btn} disabled={!!busy} onClick={() => void load()}>{busy === "load" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}Re-check</button>
      </div>

      {s && !s.storageReady && <p className="mt-2 text-xs text-warning">Trial mode: the switch stays unavailable until you approve the staged database update in chat. Until then every run uses the reviewed lane.</p>}

      {s && (
        <ul className="mt-3 space-y-3">
          {s.sites.map((site) => {
            const envOk = site.environments.every((e) => e.problems.length === 0);
            const ready = s.storageReady && site.workflowReady && envOk;
            return (
              <li key={site.repo} className="rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{site.repo}</p>
                  <span className={`text-xs font-semibold uppercase ${site.enabled ? "text-success" : "text-muted-foreground"}`}>{site.enabled ? "Automatic lane on" : "Reviewed lane only"}</span>
                </div>
                <ul className="mt-2 space-y-1 text-xs">
                  {site.environments.map((e) => (
                    <li key={e.name} className="flex gap-2">
                      {e.problems.length ? (e.problems[0] === "Not created yet." ? <CircleDashed className="h-4 w-4 shrink-0 text-warning" aria-hidden /> : <XCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden />) : <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />}
                      <span><span className="font-medium">GitHub environment {e.name}</span> — {e.problems.length ? e.problems.join(" ") : "ready (main only, no reviewers, no secrets or variables)."}</span>
                    </li>
                  ))}
                  <li className="flex gap-2">
                    {site.workflowReady ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden /> : <CircleDashed className="h-4 w-4 shrink-0 text-warning" aria-hidden />}
                    <span><span className="font-medium">Pinned workflow knows both lanes</span> — {site.workflowReady ? "yes." : "not yet: merge the lane workflow, re-save CODE_TARGETS and re-pin."}</span>
                  </li>
                </ul>
                <div className="mt-2">
                  {site.enabled
                    ? <button type="button" className={btn} disabled={!!busy} onClick={() => void toggle(site.repo, false)}>{busy === site.repo ? "Turning off…" : "Turn automatic lane off (passkey)"}</button>
                    : <button type="button" className={primaryBtn} disabled={!!busy || !ready} title={ready ? undefined : "Every line above must pass first."} onClick={() => void toggle(site.repo, true)}>{busy === site.repo ? "Turning on…" : "Turn automatic lane on (passkey)"}</button>}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {s && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-electric">Trial log — {s.trials.length ? `${yes} of ${s.trials.length} recent checks would have run automatically` : "no CODE requests checked yet"}</summary>
          <ul className="mt-2 space-y-1 text-xs">
            {s.trials.map((t, i) => <li key={i} className="flex gap-2"><time className="shrink-0 text-muted-foreground" dateTime={t.at}>{new Date(t.at).toLocaleString()}</time><span className={t.wouldAuto ? "text-success" : ""}>{t.summary}</span></li>)}
          </ul>
        </details>
      )}
      {msg && <p role="status" className={`mt-2 text-sm ${msg.tone === "error" ? "text-destructive" : "text-success"}`}>{msg.text}</p>}
    </section>
  );
}

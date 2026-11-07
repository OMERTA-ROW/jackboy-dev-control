import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { btn } from "@/components/ProjectBits";
import { useStepUp } from "@/lib/step-up-client";
import { NEVER_SKIP, SKIPPABLE, skipRuleTarget, STEP_TYPE_LABEL } from "@/lib/task-mode";
import { getSkipRules, setSkipRuleFn } from "@/lib/task-mode.functions";

/** Settings → Task Mode: which low-risk step types skip approval, per project. Saving needs a fresh passkey. */
export function TaskSkipRules() {
  const get = useServerFn(getSkipRules), save = useServerFn(setSkipRuleFn);
  const stepUp = useStepUp();
  const [data, setData] = useState<Awaited<ReturnType<typeof getSkipRules>> | null>(null);
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const load = () => get().then((r) => { setData(r); setSel(Object.fromEntries(SKIPPABLE.map((t) => [t, r.rules.find((x) => x.step_type === t)?.project_ids ?? []]))); }).catch((e) => setMsg({ text: (e as Error).message, tone: "error" }));
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saved = (t: string) => [...(data?.rules.find((x) => x.step_type === t)?.project_ids ?? [])].sort().join(",");
  const onSave = async (t: string) => {
    const ids = sel[t] ?? [];
    setBusy(t); setMsg(null);
    try {
      await stepUp("task_skip_rule", await skipRuleTarget(t, ids), { applyingText: "Saving…", apply: (grantId) => save({ data: { stepType: t, projectIds: ids, grantId } }), doneText: () => "Saved." });
      setMsg({ text: `${STEP_TYPE_LABEL[t as keyof typeof STEP_TYPE_LABEL]}: saved for ${ids.length} project(s).`, tone: "ok" });
      await load();
    } catch (e) { setMsg({ text: (e as Error).message, tone: "error" }); } finally { setBusy(null); }
  };

  return (
    <section id="task-skip" className="panel mb-4 p-4" aria-labelledby="task-skip-h">
      <h2 id="task-skip-h" className="text-sm font-semibold uppercase tracking-wider text-silver">Task Mode — steps that can skip approval</h2>
      <p className="mt-1 text-xs text-muted-foreground">Read-only checks never stop. Pick projects where these low-risk steps may run without your passkey. Saving a change needs a fresh passkey and is logged.</p>
      {!data && !msg && <p className="mt-2 text-sm text-muted-foreground">Loading…</p>}
      {data && (
        <div className="mt-3 space-y-3">
          {SKIPPABLE.map((t) => {
            const chosen = sel[t] ?? [];
            const dirty = [...chosen].sort().join(",") !== saved(t);
            return (
              <fieldset key={t} className="rounded-md border border-border p-3">
                <legend className="px-1 text-sm font-medium">{STEP_TYPE_LABEL[t]}</legend>
                <div className="grid gap-1 sm:grid-cols-2">
                  {data.projects.map((p) => (
                    <label key={p.id} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" checked={chosen.includes(p.id)} onChange={(e) => setSel((s) => ({ ...s, [t]: e.target.checked ? [...chosen, p.id] : chosen.filter((x) => x !== p.id) }))} />
                      <span className="truncate">{p.name}</span>
                    </label>
                  ))}
                </div>
                <button type="button" className={`${btn} mt-2`} disabled={!dirty || !!busy} onClick={() => void onSave(t)}>{busy === t ? "Saving…" : "Save with passkey"}</button>
              </fieldset>
            );
          })}
          <div className="rounded-md border border-border p-3">
            <p className="text-sm font-medium">Always need your passkey (can't be changed)</p>
            <ul className="mt-1 grid gap-1 sm:grid-cols-2">
              {NEVER_SKIP.map((t) => <li key={t} className="flex items-center gap-2 text-sm text-muted-foreground"><Lock className="h-3.5 w-3.5" aria-hidden />{STEP_TYPE_LABEL[t]}</li>)}
              <li className="flex items-center gap-2 text-sm text-muted-foreground"><Lock className="h-3.5 w-3.5" aria-hidden />{STEP_TYPE_LABEL.open_draft_pr}</li>
            </ul>
          </div>
        </div>
      )}
      {msg && <p role="status" className={`mt-2 text-sm ${msg.tone === "error" ? "text-destructive" : "text-success"}`}>{msg.text}</p>}
    </section>
  );
}

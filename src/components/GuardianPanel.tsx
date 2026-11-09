import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Ban, CheckCircle2, Flag, Loader2, RefreshCw, ShieldCheck, ShieldAlert } from "lucide-react";
import { btn, primaryBtn } from "@/components/ProjectBits";
import { GUARDIAN_SCOPES, TIER_OPTIONS, guardianRules, validLimits, type Verdict } from "@/lib/guardian-overview";
import { getGuardianOverview, setGuardianLimits } from "@/lib/guardian.functions";

const VERDICT: Record<Verdict, { label: string; tone: string; Icon: typeof Ban }> = {
  allowed: { label: "Allowed", tone: "text-success", Icon: CheckCircle2 },
  blocked: { label: "Blocked", tone: "text-destructive", Icon: Ban },
  flagged: { label: "Flagged", tone: "text-electric", Icon: Flag },
};
const input = "rounded-md border border-border bg-background px-2 py-1 text-sm";

/** Settings → Guardian: status, rules, recent decisions, and the owner-only limits the code already supports. */
export function GuardianPanel() {
  const get = useServerFn(getGuardianOverview), save = useServerFn(setGuardianLimits);
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["guardian-overview"], queryFn: () => get(), refetchInterval: 60_000 });
  const [form, setForm] = useState<{ tier: number; maxFiles: number; maxLines: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const [filter, setFilter] = useState<"all" | Verdict>("all");
  const p = q.data?.policy;
  useEffect(() => { if (p && !form) setForm({ tier: p.tier, maxFiles: p.maxFiles, maxLines: p.maxLines }); }, [p, form]);

  const isOwner = q.data?.role === "owner";
  const dirty = !!(p && form && (form.tier !== p.tier || form.maxFiles !== p.maxFiles || form.maxLines !== p.maxLines));
  const invalid = form ? validLimits(form) : null;
  const rules = guardianRules();
  const groups = [...new Set(rules.map((r) => r.group))];
  const events = (q.data?.activity ?? []).filter((e) => filter === "all" || e.verdict === filter);

  const onSave = async () => {
    if (!form || invalid) return;
    setBusy(true); setMsg(null);
    try {
      await save({ data: form });
      setMsg({ text: "Guardian settings saved and logged.", tone: "ok" });
      setForm(null);
      await qc.invalidateQueries({ queryKey: ["guardian-overview"] });
    } catch (e) { setMsg({ text: (e as Error).message, tone: "error" }); } finally { setBusy(false); }
  };

  return (
    <section id="guardian" aria-labelledby="guardian-h" className="panel mb-6 scroll-mt-20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="guardian-h" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-silver">
            <ShieldCheck className="h-4 w-4 text-electric" aria-hidden /> Guardian
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">Jackboy's safety checker. It runs before protected actions and refuses anything not explicitly allowed. It is built in and can't be switched off.</p>
        </div>
        <button type="button" className={btn} disabled={q.isFetching} onClick={() => void q.refetch()}>
          {q.isFetching ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}Refresh
        </button>
      </div>

      {q.isLoading && <p className="mt-3 text-sm text-muted-foreground">Reading Guardian state…</p>}
      {q.error && <p role="alert" className="mt-3 text-sm text-destructive">{(q.error as Error).message}</p>}

      {q.data && (
        <>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <div role="status" data-testid="guardian-status" className={`self-start rounded-md border px-3 py-2 ${q.data.status.state === "on" ? "border-success/40" : "border-warning/50"}`}>
              <p className="flex items-center gap-2 text-sm font-medium">
                {q.data.status.state === "on" ? <ShieldCheck className="h-4 w-4 text-success" aria-hidden /> : <ShieldAlert className="h-4 w-4 text-warning" aria-hidden />}
                {q.data.status.headline}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{q.data.status.approver}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Kill Switch: <span className="text-foreground">{p ? (p.killSwitch ? "on" : "off") : "unreadable"}</span> — change it only in <Link to="/settings" hash="activation" className="text-electric underline">Activation</Link>.
                {" "}Agents: {q.data.agents.total} registered, {q.data.agents.approved} approved, {q.data.agents.paused} paused.
              </p>
            </div>
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-silver">What it protects</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {GUARDIAN_SCOPES.map((s) => (
                  <li key={s.id}>
                    <Link to={s.to} className="font-medium text-electric hover:underline">{s.label}</Link>
                    <span className="block text-xs text-muted-foreground">{s.detail}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <details className="mt-4" open>
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-silver">Active rules ({rules.length})</summary>
            <div className="mt-2 gap-6 md:columns-2">
              {groups.map((g) => (
                <div key={g} className="mb-3 break-inside-avoid">
                  <h4 className="text-xs font-medium text-foreground">{g}</h4>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                    {rules.filter((r) => r.group === g).map((r) => <li key={r.text}>{r.text}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          </details>

          <div className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-silver">Recent activity</h3>
              <div role="group" aria-label="Filter activity" className="flex gap-1">
                {(["all", "allowed", "blocked", "flagged"] as const).map((f) => (
                  <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
                    className={`rounded-md border px-2 py-0.5 text-xs ${filter === f ? "border-electric text-electric" : "border-border text-muted-foreground"}`}>
                    {f === "all" ? "All" : VERDICT[f].label}
                  </button>
                ))}
              </div>
            </div>
            {q.data.logErrors.length > 0 && <p className="mt-1 text-xs text-destructive">Some records couldn't be read: {q.data.logErrors.join("; ")}</p>}
            {events.length === 0
              ? <p className="mt-2 text-sm text-muted-foreground">No recorded Guardian decisions{filter === "all" ? "" : ` marked ${VERDICT[filter].label.toLowerCase()}`} yet.</p>
              : (
                <ul data-testid="guardian-activity" className="mt-2 max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
                  {events.map((e) => {
                    const v = VERDICT[e.verdict];
                    return (
                      <li key={e.id} className="flex gap-2 px-3 py-2 text-sm">
                        <v.Icon className={`mt-0.5 h-4 w-4 shrink-0 ${v.tone}`} aria-hidden />
                        <div className="min-w-0">
                          <p><span className={`font-semibold ${v.tone}`}>{v.label}</span> · <span className="text-xs text-muted-foreground">{e.area} · <time dateTime={e.at}>{new Date(e.at).toLocaleString()}</time></span></p>
                          <p className="break-words text-xs text-muted-foreground">{e.reason}</p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            <p className="mt-1 text-[11px] text-muted-foreground">From the audit trail and site log. Full history in <Link to="/activity" className="underline">Logs & Approvals</Link> and <Link to="/site-log" className="underline">Site Log</Link>.</p>
          </div>

          <div className="mt-4 rounded-md border border-border p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-silver">Settings {isOwner ? "" : "(owner only — view)"}</h3>
            {!p && <p className="mt-1 text-sm text-destructive">Guardian settings couldn't be read.</p>}
            {p && form && (
              <fieldset disabled={!isOwner || busy} className="mt-2 grid gap-3 md:grid-cols-3">
                <label className="text-xs md:col-span-3">
                  <span className="block font-medium text-foreground">Approval level</span>
                  <select aria-label="Approval level" value={form.tier} onChange={(e) => setForm({ ...form, tier: Number(e.target.value) })} className={`${input} mt-1 w-full`}>
                    {TIER_OPTIONS.map((t) => <option key={t.tier} value={t.tier}>{t.tier} — {t.name}</option>)}
                  </select>
                  <span className="mt-1 block text-muted-foreground">{TIER_OPTIONS.find((t) => t.tier === form.tier)?.detail}{!p.guardianVerified && form.tier > 0 ? " Guardian isn't verified yet, so in practice everything still comes to you." : ""}</span>
                </label>
                <label className="text-xs">
                  <span className="block font-medium text-foreground">Max files per auto-approved change</span>
                  <input aria-label="Max files" type="number" min={1} max={20} value={form.maxFiles} onChange={(e) => setForm({ ...form, maxFiles: Number(e.target.value) })} className={`${input} mt-1 w-full`} />
                </label>
                <label className="text-xs">
                  <span className="block font-medium text-foreground">Max lines per auto-approved change</span>
                  <input aria-label="Max lines" type="number" min={1} max={500} value={form.maxLines} onChange={(e) => setForm({ ...form, maxLines: Number(e.target.value) })} className={`${input} mt-1 w-full`} />
                </label>
                <div className="flex items-end gap-2">
                  <button type="button" className={primaryBtn} disabled={!dirty || !!invalid} onClick={() => void onSave()}>{busy ? "Saving…" : "Save"}</button>
                  {dirty && <button type="button" className={btn} onClick={() => setForm({ tier: p.tier, maxFiles: p.maxFiles, maxLines: p.maxLines })}>Undo</button>}
                </div>
              </fieldset>
            )}
            {invalid && dirty && <p className="mt-1 text-xs text-destructive">{invalid}</p>}
            {msg && <p role="status" className={`mt-2 text-xs ${msg.tone === "ok" ? "text-success" : "text-destructive"}`}>{msg.text}</p>}
            <p className="mt-2 text-[11px] text-muted-foreground">
              These limits never override the always-yours rules above, and saving never touches the Kill Switch. Per-agent freedom and pause live in <Link to="/fleet" className="underline">Agent Fleet</Link>; agent approval in each agent's passport.
            </p>
          </div>

          <nav aria-label="Related Guardian pages" className="mt-3 flex flex-wrap gap-2 text-xs">
            <Link to="/fleet" className={btn}>Agent Fleet</Link>
            <Link to="/automation" className={btn}>Automation policy</Link>
            <Link to="/omni" className={btn}>OMNI</Link>
          </nav>
          <p className="mt-2 text-[11px] text-muted-foreground">Read at {new Date(q.data.observedAt).toLocaleTimeString()}.</p>
        </>
      )}
    </section>
  );
}

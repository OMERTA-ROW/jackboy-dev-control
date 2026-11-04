import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Power } from "lucide-react";
import { Button } from "@/components/ui/button";
import { resumeJackboyWork, stopJackboyWork } from "@/lib/code-safety.functions";
import { getAutomation } from "@/lib/automation.functions";
import { useStepUp } from "@/lib/step-up-client";

/** Owner-only Kill Switch. Turning it on or off always needs a passkey; the server re-checks the grant. */
export function WorkerSafetyBar() {
  const stop = useServerFn(stopJackboyWork);
  const resume = useServerFn(resumeJackboyWork);
  const load = useServerFn(getAutomation);
  const stepUp = useStepUp();
  const [owner, setOwner] = useState(false);
  const [paused, setPaused] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const refresh = useCallback(() => load().then((s) => { setOwner(s.role === "owner"); setPaused(s.policy?.paused ?? null); }).catch(() => setOwner(false)), [load]);
  useEffect(() => { void refresh(); }, [refresh]);
  if (!owner) return null;
  const on = paused === true;
  const toggle = async () => {
    setBusy(true);
    setNotice("");
    try {
      const grantId = await stepUp("global_pause", on ? "global_pause:off" : "global_pause:on");
      if (on) { await resume({ data: { grantId } }); setNotice("Global pause is off. The CODE stop stays engaged until CODE is unlocked separately."); }
      else { const result = await stop({ data: { grantId } }); setNotice(result.warning); }
    } catch (error) { setNotice(error instanceof Error ? error.message : "Change could not be confirmed."); }
    finally { setBusy(false); void refresh(); }
  };
  return <section aria-label="Worker safety" className="mb-4 border-b border-border pb-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Link to="/settings" className="text-sm text-silver">Worker 1 · supervised readiness</Link>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground" aria-live="polite">Kill Switch: {paused === null ? "unknown" : on ? "on — work paused" : "off"}</span>
        <Button variant="outline" size="sm" disabled={busy || paused === null} aria-busy={busy} aria-pressed={on} onClick={() => void toggle()}>
          <Power aria-hidden />{busy ? "Confirming…" : on ? "Turn Kill Switch off" : "Turn Kill Switch on"}
        </Button>
      </div>
    </div>
    {notice && <p role="alert" className="mt-2 text-sm text-muted-foreground">{notice}</p>}
  </section>;
}

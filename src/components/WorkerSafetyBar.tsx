import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { stopJackboyWork } from "@/lib/code-safety.functions";
import { getAutomation } from "@/lib/automation.functions";

export function WorkerSafetyBar() {
  const stop = useServerFn(stopJackboyWork);
  const load = useServerFn(getAutomation);
  const [owner, setOwner] = useState(false);
  useEffect(() => { void load().then((state) => setOwner(state.role === "owner")).catch(() => setOwner(false)); }, [load]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  if (!owner) return null;
  return <section aria-label="Worker safety" className="mb-4 border-b border-border pb-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Link to="/settings" className="text-sm text-silver">Worker 1 · supervised readiness</Link>
      <Button variant="destructive" disabled={busy} aria-busy={busy} onClick={async () => {
        setBusy(true);
        try { const result = await stop(); setNotice(result.warning); }
        catch (error) { setNotice(error instanceof Error ? error.message : "Stop could not be confirmed."); }
        finally { setBusy(false); }
      }}><ShieldAlert aria-hidden />{busy ? "Stopping…" : "Kill Switch — stop work"}</Button>
    </div>
    {notice && <p role="alert" className="mt-2 text-sm text-warning">{notice}</p>}
  </section>;
}
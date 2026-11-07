import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Power } from "lucide-react";
import { getAutomation } from "@/lib/automation.functions";

/** Owner-only status line on Home. The Kill Switch and emergency stop buttons live in the
 * Autonomous Activation section (Settings), one tap away, so every control is in one place. */
export function WorkerSafetyBar() {
  const load = useServerFn(getAutomation);
  const [owner, setOwner] = useState(false);
  const [paused, setPaused] = useState<boolean | null>(null);
  const refresh = useCallback(
    () =>
      load()
        .then((s) => {
          setOwner(s.role === "owner");
          setPaused(s.policy?.paused ?? null);
        })
        .catch(() => setOwner(false)),
    [load],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  if (!owner) return null;
  return (
    <section aria-label="Worker safety" className="mb-4 border-b border-border pb-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground" aria-live="polite">
          Kill Switch: {paused === null ? "unknown" : paused ? "on — work paused" : "off"}
        </span>
        <Link
          to="/settings"
          hash="activation"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-silver hover:bg-muted"
        >
          <Power className="size-4" aria-hidden />
          Kill Switch, stop &amp; activation
        </Link>
      </div>
    </section>
  );
}

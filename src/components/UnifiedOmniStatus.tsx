import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getUnifiedOmniState, reconcileOmniCancellation } from "@/lib/code-safety.functions";
import { Button } from "@/components/ui/button";

export function UnifiedOmniStatus() {
  const read = useServerFn(getUnifiedOmniState);
  const reconcile = useServerFn(reconcileOmniCancellation);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof getUnifiedOmniState>> | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await read();
        if (alive) setStatus(value);
      } catch {
        if (alive) setStatus(null);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [read]);
  async function cancel() {
    if (
      !window.confirm(
        "Disarm OMNI and retry cancellation delivery? No approval, Stop release or new execution is allowed.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      await reconcile({ data: { confirm: true } });
      setStatus(await read());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Cancellation remains unverified");
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="rounded-md border border-border p-3 space-y-2"
      aria-label="Authoritative OMNI execution state"
    >
      <h3 className="font-medium">OMNI backend: {status?.label ?? "Blocked"}</h3>
      <p className="text-sm">
        Connection: {status?.state?.connected ? "active" : "unverified"}. Configuration:{" "}
        {status?.state?.configured ? "configured" : "not configured"}. Autonomy:{" "}
        {status?.state?.armed ? "authorized" : "disarmed"}.
      </p>
      <p className="text-sm text-muted-foreground">
        Both dashboards read this Jackboy authority. Approvals never release Stop or start jobs.
        Manual OMNI diagnostics retain their separate policy.
      </p>
      {status?.state?.cancellationPending && (
        <p role="alert">Cancellation is pending; process termination has not been confirmed.</p>
      )}
      {!status?.state && (
        <p role="alert">Fresh backend safety is unverified. Execution stays blocked.</p>
      )}
      <Button disabled={busy} variant="outline" onClick={() => void cancel()}>
        Disarm and reconcile OMNI cancellation
      </Button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

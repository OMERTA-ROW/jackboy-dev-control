import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  checkCodeCancellation,
  engageCodeKillSwitch,
  getCodeSafetySettings,
  getCodePrerequisites,
  setCodeDailySpendLimit,
  setCodeSafetyTarget,
  syncCodeProviderCosts,
} from "@/lib/code-safety.functions";

type Settings = Awaited<ReturnType<typeof getCodeSafetySettings>>;

export function CodeSafetyPanel() {
  const get = useServerFn(getCodeSafetySettings);
  const checkPrerequisites = useServerFn(getCodePrerequisites);
  const [prerequisites, setPrerequisites] = useState<Awaited<ReturnType<typeof getCodePrerequisites>> | null>(null);
  const setTarget = useServerFn(setCodeSafetyTarget);
  const setLimit = useServerFn(setCodeDailySpendLimit);
  const syncCosts = useServerFn(syncCodeProviderCosts);
  const stop = useServerFn(engageCodeKillSwitch);
  const checkCancellation = useServerFn(checkCodeCancellation);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [limit, setLimitValue] = useState("5");
  const load = useCallback(
    () =>
      get()
        .then(setSettings)
        .catch((error: unknown) => {
          setMessage(
            error instanceof Error ? error.message : "CODE safety settings could not be loaded.",
          );
        }),
    [get],
  );
  useEffect(() => {
    void load();
    void checkPrerequisites().then(setPrerequisites).catch(() => {});
  }, [load, checkPrerequisites]);
  useEffect(() => {
    if (settings) setLimitValue(String(settings.dailySpendLimitUsd));
  }, [settings]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await action();
      if (result && typeof result === "object" && "cancellation" in result) {
        const cancellation = result.cancellation;
        setMessage(
          cancellation === "requested"
            ? "Emergency stop engaged and GitHub accepted the active-run cancellation request. Verify the run reaches cancelled status."
            : cancellation === "unavailable"
              ? "Emergency stop engaged. Active-run cancellation could not be confirmed; inspect GitHub Actions immediately."
              : "Emergency stop engaged; no active CODE run was recorded.",
        );
      } else if (result && typeof result === "object" && "status" in result) {
        const status = result.status;
        setMessage(
          status === "confirmed"
            ? "GitHub confirms the active run is cancelled."
            : status === "completed"
              ? "GitHub confirms the run completed; it was not confirmed as cancelled."
              : status === "requested"
                ? "GitHub accepted another cancellation request. The run is not yet confirmed stopped."
                : status === "pending"
                  ? "The run is still active; cancellation has not been confirmed."
                  : status === "unverified"
                    ? "Could not verify or request cancellation. CODE remains disabled; inspect GitHub Actions."
                    : "No active CODE run needs cancellation.",
        );
      } else if (
        result &&
        typeof result === "object" &&
        "reportedCostUsd" in result &&
        "bucketCount" in result
      ) {
        setMessage(
          `Imported ${result.bucketCount} provider-reported cost rows ($${Number(result.reportedCostUsd).toFixed(2)}). This delayed report does not enforce a hard daily cap.`,
        );
      } else {
        setMessage("The CODE allowlist was verified against GitHub and saved.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "CODE safety action failed.");
    } finally {
      setBusy(false);
      void load();
    }
  };

  return (
    <section className="panel mb-4 p-4" aria-labelledby="code-safety-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="code-safety-heading"
            className="text-sm font-semibold uppercase tracking-wider text-silver"
          >
            CODE safety controls
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Supervised execution is disabled. Provider-reported costs are daily and delayed, not a
            guaranteed hard cap; CODE cannot dispatch until a bounded daily enforcement mechanism is
            verified. This panel never dispatches execution.
          </p>
        </div>
        <Button variant="outline"
          className="rounded-md border border-destructive px-3 py-2 text-xs font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-50"
          disabled={busy || settings?.killSwitch === true}
          onClick={() => void run(() => stop())}
        >
          {settings?.killSwitch ? "Emergency stop engaged" : "Engage emergency stop"}
        </Button>
      </div>
      {message && (
        <p role="status" className="mt-3 text-sm text-warning">
          {message}
        </p>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Switch id="worker-supervised" checked={settings?.enabled === true} disabled aria-describedby="worker-activation-blocker" />
        <label htmlFor="worker-supervised" className="text-sm">Worker 1 · supervised mode (owner only)</label>
      </div>
      <p id="worker-activation-blocker" className="mt-2 text-xs text-warning">Activation locked until CODE safety storage, bounded spending and isolated-runner acceptance are verified. Each run still requires owner approval in GitHub. No autonomous distribution.</p>
      {prerequisites && <div className="mt-3 text-sm">
        <p>Target policy: {prerequisites.repository} · {prerequisites.ref} only</p>
        <p className="mt-1 text-xs text-muted-foreground">GitHub CODE / OPENAI_API_KEY: {prerequisites.openaiKeyPresent === true ? "name verified" : prerequisites.openaiKeyPresent === false ? "not found" : "secret-name access unavailable"}</p>
      </div>}
      {!settings ? (
        <p className="mt-3 text-sm text-muted-foreground">{message ? "Safety storage unavailable — execution remains blocked." : "Loading owner-only safety status…"}</p>
      ) : (
        <>
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">Execution mode</dt>
              <dd>
                {settings.enabled ? "Enabled" : "Disabled"} ·{" "}
                {settings.killSwitch ? "kill switch engaged" : "kill switch clear"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Active task</dt>
              <dd>{settings.activeRequestId ?? "None"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Emergency-stop status</dt>
              <dd>{settings.cancellationStatus}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Consecutive failures</dt>
              <dd>{settings.consecutiveFailures}/2</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Reported costs today</dt>
              <dd>
                {settings.providerCostsSyncedAt
                  ? `$${settings.spendTodayUsd.toFixed(2)} reported · not real-time`
                  : "No provider report yet"}{" "}
                · hard cap {settings.providerBudgetEnforced ? "verified" : "unverified"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Admission meter</dt>
              <dd>
                {settings.meterFresh ? "fresh" : "unavailable or stale"} · usage spike{" "}
                {settings.usageSpike ? "detected" : "not reported"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Pause reason</dt>
              <dd>{settings.pausedReason ?? "None"}</dd>
            </div>
          </dl>
          <div className="mt-3">
            <p className="text-xs text-muted-foreground">
              Provider report last synced:{" "}
              {settings.providerCostsSyncedAt
                ? new Date(settings.providerCostsSyncedAt).toLocaleString()
                : "Never"}
            </p>
            <Button variant="outline"
              className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
              disabled={busy}
              onClick={() => void run(() => syncCosts())}
            >
              Sync provider-reported costs
            </Button>
          </div>
          {settings.killSwitch &&
            settings.activeRunId &&
            settings.cancellationStatus !== "confirmed" &&
            settings.cancellationStatus !== "completed" && (
              <div className="mt-3 rounded-md border border-warning p-3" role="alert">
                <p className="text-sm font-medium text-warning">
                  CODE is disabled, but the active GitHub run is not yet confirmed stopped.
                </p>
                <Button variant="outline"
                  className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void run(() => checkCancellation())}
                >
                  Check status and retry cancellation
                </Button>
              </div>
            )}
          <div className="mt-3">
            <label className="block text-xs text-muted-foreground" htmlFor="code-daily-limit">
              Local admission threshold (USD, max $5; not a provider hard cap)
            </label>
            <div className="mt-1 flex flex-wrap gap-2">
              <input
                id="code-daily-limit"
                inputMode="decimal"
                type="number"
                min="0.01"
                max="5"
                step="0.01"
                value={limit}
                onChange={(event) => setLimitValue(event.target.value)}
                className="w-28 rounded-md border border-border bg-background px-2 py-1 text-sm"
              />
              <Button variant="outline"
                className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                disabled={
                  busy ||
                  !Number.isFinite(Number(limit)) ||
                  Number(limit) <= 0 ||
                  Number(limit) > 5 ||
                  Number(limit) === settings.dailySpendLimitUsd
                }
                onClick={() => void run(() => setLimit({ data: { limitUsd: Number(limit) } }))}
              >
                Save cap
              </Button>
            </div>
          </div>
          <div className="mt-3">
            <p className="text-xs text-muted-foreground">Owner-managed CODE_TARGETS allowlist</p>
            <ul className="mt-1 text-sm">
              {Object.entries(settings.targets).map(([repo, target]) => (
                <li key={repo}>
                  {repo} · {target.ref} · workflow {target.workflowSha.slice(0, 12)}…
                </li>
              ))}
              {!Object.keys(settings.targets).length && <li>No repository is allowed.</li>}
            </ul>
            <Button variant="outline"
              className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
              disabled={
                busy ||
                (Object.keys(settings.targets).length === 1 &&
                  settings.targets["OMERTA-ROW/jackboy-dev-control"]?.ref === "main")
              }
              onClick={() => void run(() => setTarget())}
            >
              Verify and allow OMERTA-ROW/jackboy-dev-control on main
            </Button>
          </div>
          {settings.pausedReason && (
            <p className="mt-3 text-xs text-warning">{settings.pausedReason}</p>
          )}
        </>
      )}
    </section>
  );
}

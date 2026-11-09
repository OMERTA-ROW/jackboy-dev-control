import { useServerFn } from "@tanstack/react-start";
import { ActivationPanel } from "./ActivationPanel";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { probeOmniConnection } from "@/lib/omni-link.functions";
import {
  checkCodeCancellation,
  getCodeEnableGates,
  getCodeSafetySettings,
  getCodePrerequisites,
  reconcileCodeClosedDay,
  setCodeDailySpendLimit,
  syncCodeProviderCosts,
} from "@/lib/code-safety.functions";
import { meterReasonText } from "@/lib/code-safety";

import { ACCEPTANCE_REPO } from "@/lib/code-acceptance";
type Settings = Awaited<ReturnType<typeof getCodeSafetySettings>>;

export function CodeSafetyPanel() {
  const get = useServerFn(getCodeSafetySettings);
  const checkPrerequisites = useServerFn(getCodePrerequisites);
  const [prerequisites, setPrerequisites] = useState<Awaited<
    ReturnType<typeof getCodePrerequisites>
  > | null>(null);
  const setLimit = useServerFn(setCodeDailySpendLimit);
  const syncCosts = useServerFn(syncCodeProviderCosts);
  const loadGates = useServerFn(getCodeEnableGates);
  const reconcileDay = useServerFn(reconcileCodeClosedDay);
  const [gates, setGates] = useState<Awaited<ReturnType<typeof getCodeEnableGates>> | null>(null);
  const [gatesError, setGatesError] = useState<string | null>(null);
  const probeOmni = useServerFn(probeOmniConnection);
  const [omni, setOmni] = useState<Awaited<ReturnType<typeof probeOmniConnection>> | null>(null);
  const checkCancellation = useServerFn(checkCodeCancellation);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageSource, setMessageSource] = useState<"activation" | "safety">("safety");
  const [busy, setBusy] = useState(false);
  const [limit, setLimitValue] = useState("5");
  const load = useCallback(() => {
    void loadGates()
      .then((result) => {
        setGates(result);
        setGatesError(null);
      })
      .catch((error: unknown) =>
        setGatesError(error instanceof Error ? error.message : "Gate checks could not be read."),
      );
    return get()
      .then(setSettings)
      .catch((error: unknown) => {
        setMessage(
          error instanceof Error ? error.message : "CODE safety settings could not be loaded.",
        );
      });
  }, [get, loadGates]);
  useEffect(() => {
    void load();
    void checkPrerequisites()
      .then(setPrerequisites)
      .catch(() => {});
    void probeOmni()
      .then(setOmni)
      .catch(() => {});
  }, [load, checkPrerequisites, probeOmni]);
  useEffect(() => {
    if (settings) setLimitValue(String(settings.dailySpendLimitUsd));
  }, [settings]);

  const run = async (
    action: () => Promise<unknown>,
    source: "activation" | "safety" = "safety",
  ) => {
    setBusy(true);
    setMessage(null);
    setMessageSource(source);
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
      } else if (result && typeof result === "object" && "day" in result && "message" in result) {
        setMessage(String(result.message));
      } else if (
        result &&
        typeof result === "object" &&
        "codeEnabled" in result &&
        "emergencyStop" in result &&
        !("hardCapVerified" in result)
      ) {
        setMessage(
          result.codeEnabled && !result.emergencyStop
            ? "CODE is ON and its Emergency Stop is released. Each run still needs your approval in GitHub; use Engage emergency stop to turn it off."
            : "CODE did not turn on. Nothing changed.",
        );
      } else if (
        result &&
        typeof result === "object" &&
        "hardCapVerified" in result &&
        "codeEnabled" in result &&
        "emergencyStop" in result
      ) {
        setMessage(
          `Hard cap is now ${result.hardCapVerified ? "marked verified" : "unverified"}. CODE is ${result.codeEnabled ? "ON" : "still OFF"} and Emergency Stop is ${result.emergencyStop ? "still ON" : "OFF"}.`,
        );
      } else if (
        result &&
        typeof result === "object" &&
        "paused" in result &&
        "warning" in result
      ) {
        setMessage(`Kill Switch is on. ${String(result.warning)}`);
      } else if (
        result &&
        typeof result === "object" &&
        "paused" in result &&
        Object.keys(result).length === 1
      ) {
        setMessage(
          result.paused
            ? "Kill Switch is on."
            : "Kill Switch is off. CODE stays off until you turn it on in the last step.",
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
        setMessage("CODE safety status refreshed.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "CODE safety action failed.");
    } finally {
      setBusy(false);
      void load();
    }
  };

  const activationState = settings
    ? {
        enabled: settings.enabled,
        killSwitch: settings.killSwitch,
        activeRequestId: settings.activeRequestId,
        activeRunId: settings.activeRunId,
        providerBudgetEnforced: settings.providerBudgetEnforced,
        totalSpendGuard: settings.totalSpendGuard,
      }
    : null;

  return (
    <>
      <ActivationPanel
        state={activationState}
        gates={gates?.gates ?? null}
        globalPaused={gates ? gates.globalPaused : null}
        gatesError={gatesError}
        busy={busy}
        run={(action) => run(action, "activation")}
        message={messageSource === "activation" ? message : null}
        acceptance={
          settings
            ? {
                enabled: settings.enabled,
                killSwitch: settings.killSwitch,
                globalPaused: gates ? gates.globalPaused : null,
                activeRequestId: settings.activeRequestId,
                perTaskReserveUsd: settings.perTaskReserveUsd,
                allowed: !!(settings.targets as Record<string, { workflowSha?: string }> | null)?.[ACCEPTANCE_REPO]?.workflowSha,
              }
            : null
        }
      />
      <section className="panel mb-4 p-4" aria-labelledby="code-safety-heading">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2
              id="code-safety-heading"
              className="text-sm font-semibold uppercase tracking-wider text-silver"
            >
              CODE safety details
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Supervised execution is {settings?.enabled ? "ON" : "off"}. The live meter counts the
              gateway's own record of every provider call; OpenAI's delayed reports are checked
              against it afterwards. This panel never dispatches execution.
            </p>
          </div>
        </div>
        {message && messageSource === "safety" && (
          <p role="status" className="mt-3 text-sm text-warning">
            {message}
          </p>
        )}
        <div className="mt-3 flex items-center gap-3">
          <Switch
            id="worker-supervised"
            checked={settings?.enabled === true}
            disabled
            aria-describedby="worker-activation-blocker"
          />
          <label htmlFor="worker-supervised" className="text-sm">
            Worker 1 · supervised mode (owner only)
          </label>
        </div>
        <p id="worker-activation-blocker" className="mt-2 text-xs text-warning">
          This switch only shows the current state. Turn CODE on in the last step of Autonomous
          Activation above. Each run still requires owner approval in GitHub. No autonomous
          distribution.
        </p>
        {prerequisites && (
          <div className="mt-3 text-sm">
            <p>
              Target policy: {prerequisites.repository} · {prerequisites.ref} only
            </p>
            <p className="mt-1 break-all text-xs text-muted-foreground">
              Live main workflow: {prerequisites.workflowPins.liveSha ?? "unverified"}
            </p>
            <p className="mt-1 break-all text-xs text-muted-foreground">
              Jackboy setting:{" "}
              {prerequisites.workflowPins.configuredSha ?? "unavailable or invalid"}
            </p>
            <p className="mt-1 text-xs text-warning">
              {prerequisites.workflowPins.matches
                ? "Workflow pins match."
                : "Workflow pins are stale, mismatched or unverified. Owner-approved update required; nothing changed."}
            </p>
            {prerequisites.workflowCheckError && (
              <p className="mt-1 text-xs text-warning">{prerequisites.workflowCheckError}</p>
            )}
            {Object.entries(prerequisites.environments).map(([name, evidence]) => (
              <p key={name} className="mt-1 text-xs text-muted-foreground">
                {name} reviewer gate:{" "}
                {evidence.protected
                  ? "reviewers, no self-review and no admin bypass verified"
                  : evidence.readable
                    ? "required protections not verified"
                    : "GitHub access unavailable"}
              </p>
            ))}
            <p className="mt-1 text-xs text-muted-foreground">
              Provider access is gateway-only. OPENAI_API_KEY on the GitHub runner is not a
              readiness requirement. This read-only check does not rerun isolation acceptance.
            </p>
          </div>
        )}
        {omni && (
          <div className="mt-3 text-sm" aria-label="OMNI link check">
            <p>
              OMNI link readiness ({omni.contract}):{" "}
              <span className={omni.verified ? "text-success" : "text-warning"}>
                {omni.verified ? "unexpired session recorded; live bridge not tested" : "blocked"}
              </span>
            </p>
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {omni.steps.map((step) => (
                <li key={step.name}>
                  {step.ok ? "✓" : "✗"} {step.name}: {step.detail}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!settings ? (
          <p className="mt-3 text-sm text-muted-foreground">
            {message
              ? "Safety storage unavailable — execution remains blocked."
              : "Loading owner-only safety status…"}
          </p>
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
                <dt className="text-xs text-muted-foreground">Total spending guard</dt>
                <dd>
                  {!settings.totalSpendGuard
                    ? "Not installed · CODE stays blocked"
                    : settings.totalSpendGuard.enforced
                      ? `$${settings.totalSpendGuard.committedUsd.toFixed(2)} of $${settings.totalSpendGuard.limitUsd.toFixed(2)} used, all time`
                      : "Installed but not enforced · CODE stays blocked"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Live spending meter</dt>
                <dd>
                  {!settings.spendMeter
                    ? "Not installed · CODE stays blocked"
                    : `$${settings.spendMeter.measuredTodayUsd.toFixed(2)} today (gateway $${settings.spendMeter.gatewayTodayUsd.toFixed(2)}, OpenAI $${settings.spendMeter.providerTodayUsd.toFixed(2)}) · ${settings.spendMeter.ok ? "healthy" : "blocked"}`}
                  {settings.spendMeter && !settings.spendMeter.ok && (
                    <span className="block text-xs text-warning">
                      {settings.spendMeter.reasons.map(meterReasonText).join("; ")}
                    </span>
                  )}
                  <span className="block text-xs text-muted-foreground">
                    Last task-start stamp{" "}
                    {settings.meterFresh ? "fresh" : "none or older than 5 minutes"} · usage spike{" "}
                    {settings.usageSpike ? "detected" : "not reported"}
                  </span>
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
              <div className="mt-1 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => syncCosts())}
                >
                  Sync provider-reported costs
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || !settings.spendMeter}
                  onClick={() => void run(() => reconcileDay())}
                >
                  Check a past day against OpenAI
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {settings.spendMeter?.unreportedDays.length
                  ? `Waiting on OpenAI's report for: ${settings.spendMeter.unreportedDays.join(", ")}.`
                  : "Days CODE ran must be checked against OpenAI by the end of the next day, or new tasks are blocked."}
              </p>
            </div>
            {settings.killSwitch &&
              settings.activeRunId &&
              settings.cancellationStatus !== "confirmed" &&
              settings.cancellationStatus !== "completed" && (
                <div className="mt-3 rounded-md border border-warning p-3" role="alert">
                  <p className="text-sm font-medium text-warning">
                    CODE is disabled, but the active GitHub run is not yet confirmed stopped.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
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
                <Button
                  variant="outline"
                  size="sm"
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
              <p className="text-xs text-muted-foreground">
                Database repository allowlist (separate from Jackboy’s setting)
              </p>
              <ul className="mt-1 text-sm">
                {Object.entries(settings.targets).map(([repo, target]) => (
                  <li key={repo} className="break-all">
                    {repo} · {target.ref} · workflow {target.workflowSha.slice(0, 12)}…
                  </li>
                ))}
                {!Object.keys(settings.targets).length && <li>No repository is allowed.</li>}
              </ul>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const [freshPrerequisites, freshSettings, freshOmni] = await Promise.all([
                      checkPrerequisites(),
                      get(),
                      probeOmni(),
                    ]);
                    setPrerequisites(freshPrerequisites);
                    setSettings(freshSettings);
                    setOmni(freshOmni);
                  })
                }
              >
                Refresh workflow evidence
              </Button>
            </div>
            {settings.pausedReason && (
              <p className="mt-3 text-xs text-warning">{settings.pausedReason}</p>
            )}
          </>
        )}
      </section>
    </>
  );
}

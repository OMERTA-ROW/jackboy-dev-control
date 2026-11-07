import { useServerFn } from "@tanstack/react-start";
import { ActivationReadiness } from "./ActivationReadiness";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useStepUp } from "@/lib/step-up-client";
import { probeOmniConnection } from "@/lib/omni-link.functions";
import {
  checkCodeCancellation,
  engageCodeKillSwitch,
  getCodeSafetySettings,
  getCodePrerequisites,
  setCodeDailySpendLimit,
  setCodeHardCapVerified,
  syncCodeProviderCosts,
} from "@/lib/code-safety.functions";
import { HARD_CAP_EVIDENCE_MAX, HARD_CAP_TARGET, hardCapChangeBlockReason } from "@/lib/code-safety";

type Settings = Awaited<ReturnType<typeof getCodeSafetySettings>>;

export function CodeSafetyPanel() {
  const get = useServerFn(getCodeSafetySettings);
  const checkPrerequisites = useServerFn(getCodePrerequisites);
  const [prerequisites, setPrerequisites] = useState<Awaited<ReturnType<typeof getCodePrerequisites>> | null>(null);
  const setLimit = useServerFn(setCodeDailySpendLimit);
  const syncCosts = useServerFn(syncCodeProviderCosts);
  const stop = useServerFn(engageCodeKillSwitch);
  const setHardCap = useServerFn(setCodeHardCapVerified);
  const [capNote, setCapNote] = useState("");
  const stepUp = useStepUp();
  const probeOmni = useServerFn(probeOmniConnection);
  const [omni, setOmni] = useState<Awaited<ReturnType<typeof probeOmniConnection>> | null>(null);
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
    void probeOmni().then(setOmni).catch(() => {});
  }, [load, checkPrerequisites, probeOmni]);
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
      } else if (result && typeof result === "object" && "hardCapVerified" in result && "codeEnabled" in result && "emergencyStop" in result) {
        setCapNote("");
        setMessage(
          `Hard cap is now ${result.hardCapVerified ? "marked verified" : "unverified"}. CODE is ${result.codeEnabled ? "ON" : "still OFF"} and Emergency Stop is ${result.emergencyStop ? "still ON" : "OFF"}.`,
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
        <Button variant="outline" size="sm"
          disabled={busy || settings?.killSwitch === true}
          onClick={() => void run(() => stepUp("global_pause", "global_pause:on").then((grantId) => stop({ data: { grantId } })))}
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
        <p className="mt-1 break-all text-xs text-muted-foreground">Live main workflow: {prerequisites.workflowPins.liveSha ?? "unverified"}</p>
        <p className="mt-1 break-all text-xs text-muted-foreground">Jackboy setting: {prerequisites.workflowPins.configuredSha ?? "unavailable or invalid"}</p>
        <p className="mt-1 text-xs text-warning">{prerequisites.workflowPins.matches ? "Workflow pins match." : "Workflow pins are stale, mismatched or unverified. Owner-approved update required; nothing changed."}</p>
        {prerequisites.workflowCheckError && <p className="mt-1 text-xs text-warning">{prerequisites.workflowCheckError}</p>}
        {Object.entries(prerequisites.environments).map(([name, evidence]) => <p key={name} className="mt-1 text-xs text-muted-foreground">{name} reviewer gate: {evidence.protected ? "reviewers, no self-review and no admin bypass verified" : evidence.readable ? "required protections not verified" : "GitHub access unavailable"}</p>)}
        <p className="mt-1 text-xs text-muted-foreground">Provider access is gateway-only. OPENAI_API_KEY on the GitHub runner is not a readiness requirement. This read-only check does not rerun isolation acceptance.</p>
      </div>}
      {omni && <div className="mt-3 text-sm" aria-label="OMNI link check">
        <p>OMNI link readiness ({omni.contract}): <span className={omni.verified ? "text-success" : "text-warning"}>{omni.verified ? "unexpired session recorded; live bridge not tested" : "blocked"}</span></p>
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {omni.steps.map((step) => <li key={step.name}>{step.ok ? "✓" : "✗"} {step.name}: {step.detail}</li>)}
        </ul>
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
          {(() => {
            const marking = !settings.providerBudgetEnforced;
            const current = {
              enabled: settings.enabled,
              killSwitch: settings.killSwitch,
              activeRequestId: settings.activeRequestId,
              activeRunId: settings.activeRunId,
              providerBudgetEnforced: settings.providerBudgetEnforced,
              totalSpendGuard: settings.totalSpendGuard,
            };
            const blocked = hardCapChangeBlockReason({ verified: marking, evidence: capNote, current });
            // State reasons (CODE on, stop off, guard missing) show even before a note is typed.
            const stateBlocked = hardCapChangeBlockReason({ verified: marking, evidence: "evidence-ok", current });
            return (
              <div className="mt-3 rounded-md border border-border p-3" aria-labelledby="hard-cap-heading">
                <p id="hard-cap-heading" className="text-sm font-medium">
                  Provider hard cap: {settings.providerBudgetEnforced ? "marked verified by owner" : "unverified"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {marking
                    ? "Mark it verified only after you have confirmed the spending cap with the provider. This does not turn CODE on or release the Emergency Stop."
                    : "Un-marking blocks every new CODE task until you mark it again."}{" "}
                  Needs a new passkey check every time, and works only while CODE is off and the Emergency Stop is on.
                </p>
                <label htmlFor="hard-cap-note" className="mt-2 block text-xs text-muted-foreground">
                  Evidence note (what you checked, where and when)
                </label>
                <textarea
                  id="hard-cap-note"
                  value={capNote}
                  maxLength={HARD_CAP_EVIDENCE_MAX}
                  rows={2}
                  onChange={(event) => setCapNote(event.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
                />
                {blocked && (capNote.trim().length > 0 || stateBlocked) && (
                  <p className="mt-1 text-xs text-warning">{stateBlocked ?? blocked}</p>
                )}
                <Button variant="outline" size="sm" className="mt-2"
                  disabled={busy || blocked !== null}
                  onClick={() => void run(() =>
                    stepUp("code_hard_cap", marking ? HARD_CAP_TARGET.mark : HARD_CAP_TARGET.unmark).then((grantId) =>
                      setHardCap({ data: { grantId, verified: marking, evidence: capNote.trim() } }),
                    ),
                  )}
                >
                  {marking ? "Mark hard cap verified with passkey" : "Un-mark hard cap with passkey"}
                </Button>
              </div>
            );
          })()}
          <div className="mt-3">
            <p className="text-xs text-muted-foreground">
              Provider report last synced:{" "}
              {settings.providerCostsSyncedAt
                ? new Date(settings.providerCostsSyncedAt).toLocaleString()
                : "Never"}
            </p>
            <Button variant="outline" size="sm"
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
                <Button variant="outline" size="sm"
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
              <Button variant="outline" size="sm"
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
            <p className="text-xs text-muted-foreground">Database repository allowlist (separate from Jackboy’s setting)</p>
            <ul className="mt-1 text-sm">
              {Object.entries(settings.targets).map(([repo, target]) => (
                <li key={repo} className="break-all">
                  {repo} · {target.ref} · workflow {target.workflowSha.slice(0, 12)}…
                </li>
              ))}
              {!Object.keys(settings.targets).length && <li>No repository is allowed.</li>}
            </ul>
            <Button variant="outline" size="sm"
              disabled={busy}
              onClick={() => void run(async () => {
                const [freshPrerequisites, freshSettings, freshOmni] = await Promise.all([checkPrerequisites(), get(), probeOmni()]);
                setPrerequisites(freshPrerequisites); setSettings(freshSettings); setOmni(freshOmni);
              })}
            >
              Refresh workflow evidence
            </Button>
          </div>
          {settings.pausedReason && (
            <p className="mt-3 text-xs text-warning">{settings.pausedReason}</p>
          )}
        </>
      )}
      <ActivationReadiness live={settings && prerequisites ? {
        checkedAt: settings.checkedAt < prerequisites.checkedAt ? settings.checkedAt : prerequisites.checkedAt,
        pinsMatch: prerequisites.workflowPins.matches,
        disabled: settings.enabled === false,
        stopped: settings.killSwitch === true,
        noActiveRun: settings.activeRequestId === null && settings.activeRunId === null,
        gatesProtected: prerequisites.environments.CODE.protected && prerequisites.environments["CODE-PUBLISH"].protected,
      } : null} />
    </section>
  );
}

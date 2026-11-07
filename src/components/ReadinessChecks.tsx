import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { getReadiness, testReadiness } from "@/lib/readiness.functions";
import { testCodeProviderGateway } from "@/lib/code-safety.functions";
import { passkeyTestOptions, passkeyTestVerify } from "@/lib/passkey.functions";
import { requestPasskey } from "@/lib/passkey-prompt";
import {
  PUBLISHED_RP_ID,
  READINESS,
  type ReadinessDef,
  type ReadinessId,
  type ReadinessResult,
} from "@/lib/readiness";

type Props = {
  /** True while another control in the panel is running; when it finishes the list re-reads. */
  busy: boolean;
  onEmergencyStop: () => void;
  onStartActivation: () => void;
  emergencyStopEngaged: boolean;
};

const REFRESH_MS = 60_000;

const tone = (s: ReadinessResult["status"]) =>
  s === "PASS" ? "text-success" : s === "BLOCKED" ? "text-destructive" : "text-warning";

function when(at: string) {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

/** Live readiness: every item has a real read-only Test, and statuses follow real use anywhere on the
 * site (re-read on focus, every minute, and after any control in this panel). */
export function ReadinessChecks({
  busy,
  onEmergencyStop,
  onStartActivation,
  emergencyStopEngaged,
}: Props) {
  const load = useServerFn(getReadiness);
  const test = useServerFn(testReadiness);
  const testGateway = useServerFn(testCodeProviderGateway);
  const pkOptions = useServerFn(passkeyTestOptions);
  const pkVerify = useServerFn(passkeyTestVerify);
  const [items, setItems] = useState<Record<ReadinessId, ReadinessResult> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<ReadinessId | "all" | null>(null);
  const [host, setHost] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      load()
        .then((r) => {
          setItems(r.items);
          setError(null);
        })
        .catch((e: unknown) =>
          setError(e instanceof Error ? e.message : "Readiness could not be read."),
        ),
    [load],
  );

  useEffect(() => {
    setHost(window.location.hostname);
    void refresh();
    const onFocus = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(onFocus, REFRESH_MS);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  // Another control in the panel (stop, pause, hard cap, on-switch) just finished: read again.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) void refresh();
    wasBusy.current = busy;
  }, [busy, refresh]);

  const runOne = async (def: ReadinessDef) => {
    if (def.test === "passkey") {
      await requestPasskey({
        title: "Test my passkey",
        description: "A real check on your device. It changes nothing.",
        prepare: async () => {
          const o = await pkOptions();
          return { kind: "auth", challengeId: o.challengeId, options: o.options, keys: o.keys };
        },
        finish: (challengeId, response) => pkVerify({ data: { challengeId, response } }),
        successText: () => "Passkey works.",
      });
      return;
    }
    if (def.id === "provider_gateway") await testGateway();
    else await test({ data: { item: def.id } });
  };

  const run = async (def: ReadinessDef) => {
    setRunning(def.id);
    setError(null);
    try {
      await runOne(def);
    } catch (e) {
      setError(`${def.name}: ${e instanceof Error ? e.message : "the test could not run."}`);
    } finally {
      setRunning(null);
      void refresh();
    }
  };

  const runAll = async () => {
    setRunning("all");
    setError(null);
    for (const def of READINESS) {
      if (def.test === "passkey") continue; // needs your device, so never started automatically
      try {
        await runOne(def);
      } catch {
        // Each failure is recorded by the server as that item's result.
      }
    }
    setRunning(null);
    void refresh();
  };

  const passed = items ? READINESS.filter((d) => items[d.id]?.status === "PASS").length : 0;

  return (
    <div aria-labelledby="readiness-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="readiness-heading" className="text-sm font-semibold text-silver">
            Readiness checks
          </h3>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {items ? `${passed} of ${READINESS.length} passing.` : "Reading live status…"} Tests
            only read; they never turn anything on.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={running !== null}
          onClick={() => void runAll()}
        >
          {running === "all" ? "Testing…" : "Test all"}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-warning">
          {error}
        </p>
      )}
      <ul className="mt-3 divide-y divide-border" aria-label="Readiness items">
        {READINESS.map((def) => {
          const r = items?.[def.id];
          const offLive = def.test === "passkey" && host !== null && host !== PUBLISHED_RP_ID;
          return (
            <li key={def.id} className="py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {def.name}{" "}
                    <span
                      className={`text-xs font-semibold ${r ? tone(r.status) : "text-muted-foreground"}`}
                    >
                      {r?.status ?? "…"}
                    </span>
                  </p>
                  {r && <p className="mt-0.5 text-xs">{r.reason}</p>}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {r?.at
                      ? `${r.source === "live" ? "Read live" : "Tested"} ${when(r.at)}. `
                      : ""}
                    {def.what}
                    {offLive ? " You're not on the live site, so a test here won't count." : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={running !== null}
                    aria-label={`Test ${def.name}`}
                    onClick={() => void run(def)}
                  >
                    {running === def.id
                      ? "Testing…"
                      : def.test === "passkey"
                        ? "Test with passkey"
                        : "Test"}
                  </Button>
                  {def.block === "emergency_stop" && (
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={busy || emergencyStopEngaged}
                      aria-label={`Block ${def.name}`}
                      onClick={onEmergencyStop}
                    >
                      Block
                    </Button>
                  )}
                  {def.unblock === "start_activation" &&
                    (def.id === "code_runtime" ? emergencyStopEngaged : r?.status !== "PASS") && (
                      <Button
                        size="sm"
                        disabled={busy}
                        aria-label={`Unblock ${def.name}`}
                        onClick={onStartActivation}
                      >
                        Unblock
                      </Button>
                    )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

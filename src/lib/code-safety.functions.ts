import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { CODE_WORKFLOW } from "./code";
import {
  classifyGithubCancellationState,
  closedDayToReconcile,
  CODE_DAILY_SPEND_LIMIT_USD,
  CODE_DISABLE_TARGET,
  CODE_ENABLE_TARGET,
  CODE_STOP_RELEASE_TARGET,
  codeEnableBlockReason,
  codeEnableGates,
  enableRefusalText,
  parseSpendMeter,
  type CodeEnableInput,
  HARD_CAP_EVIDENCE_MAX,
  HARD_CAP_EVIDENCE_MIN,
  HARD_CAP_TARGET,
  hardCapChangeBlockReason,
  parseCodeTargets,
  parseTotalSpendGuard,
  stopReleaseBlockReason,
  stopReleaseGates,
} from "./code-safety";
import type { OpenAICostRow } from "./openai-costs";

const REPOSITORY = "OMERTA-ROW/jackboy-dev-control";

/** Read-only readiness: never dispatches, reads secret values, or changes GitHub configuration. */
export const getCodePrerequisites = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const [execution, publishing, workflow] = await Promise.allSettled([
      fetchGithub<{ protection_rules?: { type: string; prevent_self_review?: boolean; reviewers?: unknown[] }[]; can_admins_bypass?: boolean }>("/environments/CODE"),
      fetchGithub<{ protection_rules?: { type: string; prevent_self_review?: boolean; reviewers?: unknown[] }[]; can_admins_bypass?: boolean }>("/environments/CODE-PUBLISH"),
      fetchGithub<{ sha: string }>(`/contents/.github/workflows/${CODE_WORKFLOW}?ref=main`),
    ]);
    const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const { data, error } = await db.from("code_runtime_controls").select("allowed_targets").eq("singleton", true).single();
    const { workflowPinReport } = await import("./code-workflow-readiness");
    const liveSha = workflow.status === "fulfilled" ? workflow.value.sha : null;
    const environment = (result: typeof execution) => {
      if (result.status === "rejected") return { readable: false, protected: false };
      const reviewers = result.value.protection_rules?.find((rule) => rule.type === "required_reviewers");
      return { readable: true, protected: reviewers?.prevent_self_review === true && (reviewers.reviewers?.length ?? 0) > 0 && result.value.can_admins_bypass === false };
    };
    return {
      checkedAt: new Date().toISOString(),
      repository: REPOSITORY,
      ref: "main",
      environments: { CODE: environment(execution), "CODE-PUBLISH": environment(publishing) },
      workflowPins: workflowPinReport(error ? null : data?.allowed_targets, process.env["CODE_TARGETS"], liveSha),
      workflowCheckError: workflow.status === "rejected" ? (workflow.reason instanceof Error ? workflow.reason.message : "GitHub workflow could not be read.") : null,
    };
  });

/** Stops local admission first; external cancellation is requested, never described as instantaneous. */
export const GLOBAL_PAUSE_ON = "global_pause:on";
export const GLOBAL_PAUSE_OFF = "global_pause:off";
const grantInput = (d: unknown) => z.object({ grantId: z.string().uuid() }).parse(d);

/** True only when the database itself refuses every CODE start and AI call while the Kill Switch is on
 * (the independent-controls change is installed). Any error or other answer counts as false, so the
 * Kill Switch keeps engaging the CODE stop until the database proves it no longer needs to. */
async function independentControlsInstalled(db: ReturnType<typeof import("./untyped-db").untyped>): Promise<boolean> {
  try {
    const { data, error } = await db.rpc("code_independent_controls_installed");
    return !error && data === true;
  } catch {
    return false;
  }
}

const NOT_INSTALLED =
  "Nothing changed: the database update that keeps CODE, the Emergency Stop and the Kill Switch separate is not installed yet (it waits for your approval). The Emergency Stop still works and blocks CODE at once.";

export const stopJackboyWork = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(grantInput)
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    await (await import("./passkey.server")).consumeGrant(data.grantId, context.userId, "global_pause", GLOBAL_PAUSE_ON);
    const { data: policy, error: readError } = await context.supabase.from("automation_policy").select("tier,max_files,max_lines").eq("id", 1).single();
    if (readError || !policy) throw new Error("Emergency stop policy is unavailable.");
    const { error } = await context.supabase.rpc("set_automation_policy", { _tier: policy.tier, _paused: true, _max_files: policy.max_files, _max_lines: policy.max_lines });
    if (error) throw new Error("Global emergency pause could not be saved.");
    const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const { error: foundryError } = await db.from("foundry_schedule").update({ paused: true, updated_at: new Date().toISOString() }).eq("id", 1);
    const independent = await independentControlsInstalled(db);
    // Until the database enforces the Kill Switch for CODE itself, the Kill Switch must also engage the
    // CODE stop (the old, coupled behaviour) so it never becomes less safe.
    let codeStopSaved: boolean | null = null;
    if (!independent) {
      const { error: codeError } = await db.rpc("engage_code_kill_switch", { p_actor: context.userId });
      codeStopSaved = !codeError;
    }
    const { data: controls } = await db.from("code_runtime_controls").select("active_request_id, active_run_id").eq("singleton", true).maybeSingle();
    const activeTask = !controls || !!controls.active_request_id || !!controls.active_run_id;
    const { error: auditError } = await context.supabase.rpc("write_audit", {
      _action: "worker.kill_switch",
      _detail: { global_paused: true, foundry_paused: !foundryError, code_controls: independent ? "unchanged" : "legacy_stop_engaged", code_stop_saved: codeStopSaved },
      _outcome: foundryError || codeStopSaved === false ? "partial" : "ok",
    });
    const running = activeTask
      ? " A CODE task may still be running in GitHub: press Engage emergency stop to cancel it and confirm it stopped."
      : "";
    return {
      paused: true,
      codeStopSaved,
      codeControlsChanged: !independent && codeStopSaved === true,
      warning: independent
        ? `All Jackboy work is paused. The saved CODE setting and the CODE Emergency Stop were not changed; while the Kill Switch is on the database refuses every CODE start and AI call.${running}${foundryError || auditError ? " Some other worker controls or audit storage are unavailable." : ""}`
        : codeStopSaved === false
          ? "Kill Switch saved, but the CODE Emergency Stop could NOT be saved. Press Engage emergency stop now and confirm any running job is cancelled in GitHub."
          : foundryError || auditError
            ? "Kill Switch and CODE Emergency Stop saved (the database update that keeps them separate is not installed yet). Some other worker controls or audit storage are unavailable. Any external run must be cancelled and confirmed in GitHub."
            : "New work is blocked and the CODE Emergency Stop is engaged too, because the database update that keeps them separate is not installed yet. Any already-running external job must be cancelled and confirmed in GitHub.",
    };
  });

/** One light, owner-only read of the three safety controls for live refresh. Read-only; never changes
 * anything and never calls GitHub. Unreadable parts come back null so the page shows them as unknown. */
export const getSafetyControlState = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const [policy, controls, independent] = await Promise.all([
      db.from("automation_policy").select("paused, updated_at").eq("id", 1).maybeSingle(),
      db.from("code_runtime_controls")
        .select("enabled, kill_switch, active_request_id, active_run_id, cancellation_status, paused_reason, stop_requested_at, updated_at")
        .eq("singleton", true)
        .maybeSingle(),
      independentControlsInstalled(db),
    ]);
    const p = policy.error ? null : policy.data;
    const c = controls.error ? null : controls.data;
    return {
      checkedAt: new Date().toISOString(),
      globalPaused: p && typeof p.paused === "boolean" ? p.paused : null,
      globalPauseUpdatedAt: p?.updated_at ?? null,
      /** The database keeps the three controls separate (draft change installed). */
      independentControls: independent,
      code: c && typeof c.enabled === "boolean" && typeof c.kill_switch === "boolean"
        ? {
            enabled: c.enabled as boolean,
            killSwitch: c.kill_switch as boolean,
            activeRequestId: (c.active_request_id as string | null) ?? null,
            activeRunId: (c.active_run_id as number | null) ?? null,
            cancellationStatus: String(c.cancellation_status ?? "unknown"),
            pausedReason: (c.paused_reason as string | null) ?? null,
            stopRequestedAt: (c.stop_requested_at as string | null) ?? null,
            updatedAt: (c.updated_at as string | null) ?? null,
          }
        : null,
    };
  });

/** Turns the System Kill Switch OFF after a passkey. Never changes the saved CODE setting or the CODE Emergency Stop. */
export const resumeJackboyWork = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(grantInput)
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    await (await import("./passkey.server")).consumeGrant(data.grantId, context.userId, "global_pause", GLOBAL_PAUSE_OFF);
    const { data: policy, error: readError } = await context.supabase.from("automation_policy").select("tier,max_files,max_lines").eq("id", 1).single();
    if (readError || !policy) throw new Error("Global pause policy is unavailable.");
    const { error } = await context.supabase.rpc("set_automation_policy", { _tier: policy.tier, _paused: false, _max_files: policy.max_files, _max_lines: policy.max_lines });
    if (error) throw new Error("Global pause could not be turned off.");
    await context.supabase.rpc("write_audit", { _action: "worker.kill_switch_off", _detail: { global_paused: false, code_kill_switch: "unchanged" }, _outcome: "ok" });
    return { paused: false };
  });

/** Owner marks (or un-marks) the provider hard cap as verified. Needs a NEW passkey check bound to the
 * direction, and only works while CODE is off, the Emergency Stop is on and no task is active.
 * It never enables CODE or releases the Emergency Stop; the database gate re-checks everything. */
export const setCodeHardCapVerified = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        grantId: z.string().uuid(),
        verified: z.boolean(),
        evidence: z.string().trim().min(HARD_CAP_EVIDENCE_MIN).max(HARD_CAP_EVIDENCE_MAX),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    const target = data.verified ? HARD_CAP_TARGET.mark : HARD_CAP_TARGET.unmark;
    await (await import("./passkey.server")).consumeGrant(data.grantId, context.userId, "code_hard_cap", target, { requireFresh: true });
    const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const { data: controls, error } = await db
      .from("code_runtime_controls")
      .select("enabled, kill_switch, active_request_id, active_run_id, provider_hard_cap_verified")
      .eq("singleton", true)
      .single();
    if (error || !controls) throw new Error("CODE safety controls are unavailable; nothing changed.");
    const guardResult = await db.rpc("code_total_spend_guard_status");
    const blocked = hardCapChangeBlockReason({
      verified: data.verified,
      evidence: data.evidence,
      current: {
        enabled: controls.enabled,
        killSwitch: controls.kill_switch,
        activeRequestId: controls.active_request_id,
        activeRunId: controls.active_run_id,
        providerBudgetEnforced: controls.provider_hard_cap_verified,
        totalSpendGuard: parseTotalSpendGuard(guardResult.error ? null : guardResult.data),
      },
    });
    if (blocked) throw new Error(`${blocked} Nothing changed.`);
    const { error: setError } = await db.rpc("set_code_provider_hard_cap_verified", {
      p_actor: context.userId,
      p_verified: data.verified,
      p_evidence: data.evidence,
    });
    if (setError) throw new Error("The database refused the hard-cap change; nothing changed.");
    const { data: after } = await db
      .from("code_runtime_controls")
      .select("enabled, kill_switch, provider_hard_cap_verified")
      .eq("singleton", true)
      .single();
    return {
      hardCapVerified: after?.provider_hard_cap_verified === true,
      codeEnabled: after?.enabled === true,
      emergencyStop: after?.kill_switch === true,
    };
  });

/** Readiness Test for the provider gateway: settings check plus a free model-visibility read
 * (no model is run). Result is appended to the site log; nothing is turned on. */
export const testCodeProviderGateway = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const { probeProviderAccess } = await import("./code-gateway.server");
    const probe = await probeProviderAccess();
    const { recordReadinessTest } = await import("./readiness.server");
    return recordReadinessTest("provider_gateway", { status: probe.ok ? "PASS" : "BLOCKED", reason: probe.reason }, context.userId);
  });

/** Names/format only: never returns or logs a secret value. */
async function gatewaySettingsPresent(): Promise<boolean> {
  const { codeGatewayProviderKeyPresent } = await import("./code-gateway.server");
  if (!codeGatewayProviderKeyPresent()) return false;
  const cap = Number(process.env["CODE_GATEWAY_PER_CALL_CAP_USD"]);
  if (!Number.isFinite(cap) || cap <= 0 || cap > 5) return false;
  try {
    const { parsePriceTable } = await import("./code-gateway");
    return Object.keys(parsePriceTable(process.env["CODE_GATEWAY_PRICES"])).length > 0;
  } catch {
    return false;
  }
}
function costCheckSettingsPresent(): boolean {
  const projectId = process.env["OPENAI_CODE_PROJECT_ID"];
  const apiKeyId = process.env["OPENAI_CODE_API_KEY_ID"];
  return !!process.env["OPENAI_ADMIN_KEY"] && !!projectId && !!apiKeyId && projectId.length <= 200 && apiKeyId.length <= 200;
}

/** Fresh, server-side read of every input the owner switch checks. Unreadable parts fail closed. */
async function collectEnableInput(): Promise<CodeEnableInput> {
  const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
  const [controlsResult, guardResult, meterResult, policyResult, workflow, gatewayConfigured] = await Promise.all([
    db.from("code_runtime_controls")
      .select("enabled, kill_switch, active_request_id, active_run_id, consecutive_failures, usage_spike, cancellation_status, provider_hard_cap_verified, per_task_reserve_usd, allowed_targets")
      .eq("singleton", true)
      .single(),
    db.rpc("code_total_spend_guard_status"),
    db.rpc("code_spend_meter_status"),
    db.from("automation_policy").select("paused").eq("id", 1).single(),
    fetchGithub<{ sha: string }>(`/contents/.github/workflows/${CODE_WORKFLOW}?ref=main`).then((w) => w.sha, () => null),
    gatewaySettingsPresent(),
  ]);
  const c = controlsResult.data;
  if (controlsResult.error || !c) throw new Error("CODE safety controls are unavailable; nothing changed.");
  const { workflowPinReport } = await import("./code-workflow-readiness");
  const liveSha = typeof workflow === "string" ? workflow : null;
  const reserve = Number(c.per_task_reserve_usd);
  return {
    enabled: c.enabled === true,
    killSwitch: c.kill_switch === true,
    activeRequestId: c.active_request_id,
    activeRunId: c.active_run_id,
    consecutiveFailures: Number(c.consecutive_failures),
    usageSpike: c.usage_spike === true,
    cancellationStatus: String(c.cancellation_status),
    providerBudgetEnforced: c.provider_hard_cap_verified === true,
    totalSpendGuard: parseTotalSpendGuard(guardResult.error ? null : guardResult.data),
    perTaskReserveUsd: Number.isFinite(reserve) ? reserve : null,
    spendMeter: parseSpendMeter(meterResult.error ? null : meterResult.data),
    globalPaused: policyResult.error || !policyResult.data ? null : policyResult.data.paused === true,
    pinsMatch: liveSha ? workflowPinReport(c.allowed_targets, process.env["CODE_TARGETS"], liveSha).matches : null,
    gatewayConfigured,
    costCheckConfigured: costCheckSettingsPresent(),
  };
}

/** Read-only gate checklist for the owner switch. Never changes anything. */
export const getCodeEnableGates = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const input = await collectEnableInput();
    const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    return {
      checkedAt: new Date().toISOString(),
      gates: codeEnableGates(input),
      releaseGates: stopReleaseGates(input),
      independentControls: await independentControlsInstalled(db),
      meter: input.spendMeter,
      globalPaused: input.globalPaused,
    };
  });

async function readControls(db: ReturnType<typeof import("./untyped-db").untyped>) {
  const [c, p] = await Promise.all([
    db.from("code_runtime_controls").select("enabled, kill_switch").eq("singleton", true).maybeSingle(),
    db.from("automation_policy").select("paused").eq("id", 1).maybeSingle(),
  ]);
  return {
    enabled: c.error || !c.data ? null : c.data.enabled === true,
    emergencyStop: c.error || !c.data ? null : c.data.kill_switch === true,
    killSwitch: p.error || !p.data ? null : p.data.paused === true,
  };
}

/** Saved CODE setting ON/OFF. Needs a NEW passkey bound to the direction. Turning ON re-checks every
 * owner authorisation, allowlist, metering and budget requirement here and again in the database. It
 * never changes the Emergency Stop or the Kill Switch, and the read-back proves that. */
export const setCodeEnabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ grantId: z.string().uuid(), enabled: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    if (!(await independentControlsInstalled(db))) throw new Error(NOT_INSTALLED);
    await (await import("./passkey.server")).consumeGrant(
      data.grantId, context.userId, "code_enable", data.enabled ? CODE_ENABLE_TARGET : CODE_DISABLE_TARGET, { requireFresh: true },
    );
    const before = await readControls(db);
    if (data.enabled) {
      const blocked = codeEnableBlockReason(await collectEnableInput());
      if (blocked) throw new Error(`CODE was not turned on. ${blocked} Nothing changed.`);
    }
    const { data: result, error } = await db.rpc("set_code_enabled", { p_actor: context.userId, p_enabled: data.enabled });
    if (error || !result) throw new Error(`The database refused to turn CODE ${data.enabled ? "on" : "off"}; nothing changed.`);
    if (result.ok !== true) throw new Error(`CODE was not turned on: ${enableRefusalText(result.reasons)}. Nothing changed.`);
    const after = await readControls(db);
    const othersUnchanged = after.emergencyStop === before.emergencyStop && after.killSwitch === before.killSwitch;
    const ok = after.enabled === data.enabled;
    return {
      control: "code_enabled" as const,
      ok,
      codeEnabled: after.enabled,
      emergencyStop: after.emergencyStop,
      killSwitch: after.killSwitch,
      othersUnchanged,
      message: !ok
        ? `The request finished, but the saved CODE setting still reads ${after.enabled === null ? "unknown" : after.enabled ? "ON" : "OFF"}.`
        : `Saved CODE setting is now ${data.enabled ? "ON" : "OFF"}. Emergency Stop ${after.emergencyStop ? "is still engaged" : "is still released"} and the Kill Switch ${after.killSwitch ? "is still on" : "is still off"} — neither was changed.${data.enabled && (after.emergencyStop !== false || after.killSwitch !== false) ? " CODE cannot run until both are off." : ""}`,
    };
  });

/** Releases the CODE Emergency Stop only. Needs a NEW passkey for this exact action. Refused while any
 * emergency protection holds (running or unconfirmed task, two-failure stop, usage spike) or the hard
 * cap / $10 guard is not in place. Never turns CODE on and never changes the Kill Switch. */
export const releaseCodeEmergencyStop = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(grantInput)
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    if (!(await independentControlsInstalled(db))) throw new Error(NOT_INSTALLED);
    await (await import("./passkey.server")).consumeGrant(data.grantId, context.userId, "code_stop_release", CODE_STOP_RELEASE_TARGET, { requireFresh: true });
    const before = await readControls(db);
    const blocked = stopReleaseBlockReason(await collectEnableInput());
    if (blocked) throw new Error(`The Emergency Stop was not released. ${blocked} Nothing changed.`);
    const { data: result, error } = await db.rpc("release_code_emergency_stop", { p_actor: context.userId });
    if (error || !result) throw new Error("The database refused to release the Emergency Stop; nothing changed.");
    if (result.ok !== true) throw new Error(`The Emergency Stop was not released: ${enableRefusalText(result.reasons)}. Nothing changed.`);
    const after = await readControls(db);
    const ok = after.emergencyStop === false;
    return {
      control: "emergency_stop_release" as const,
      ok,
      codeEnabled: after.enabled,
      emergencyStop: after.emergencyStop,
      killSwitch: after.killSwitch,
      othersUnchanged: after.enabled === before.enabled && after.killSwitch === before.killSwitch,
      message: !ok
        ? "The request finished, but the Emergency Stop still reads as engaged."
        : `Emergency Stop released. Saved CODE setting is still ${after.enabled ? "ON" : "OFF"} and the Kill Switch is still ${after.killSwitch ? "on" : "off"} — neither was changed.${after.enabled !== true || after.killSwitch !== false ? " CODE still cannot run." : ""}`,
    };
  });

/** OpenAI cross-check: records the closed-day cost report for the oldest past day the meter is waiting
 * on (or yesterday), then reconciles it against what the gateway admitted. A mismatch engages the stop. */
export const reconcileCodeClosedDay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const { costReportSettings, fetchOpenAICostRows } = await import("./openai-costs.server");
    const settings = costReportSettings();
    if (!settings) throw new Error("OpenAI cost cross-check is unavailable: configure OPENAI_ADMIN_KEY, OPENAI_CODE_PROJECT_ID and OPENAI_CODE_API_KEY_ID.");
    const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const meterResult = await db.rpc("code_spend_meter_status");
    const meter = parseSpendMeter(meterResult.error ? null : meterResult.data);
    if (!meter) throw new Error("The live spending meter is not installed yet; nothing to reconcile.");
    const day = closedDayToReconcile(meter.unreportedDays, new Date());
    const start = new Date(`${day}T00:00:00Z`);
    const end = new Date(start.getTime() + 86_400_000);
    const rows = await fetchOpenAICostRows(settings, start, end);
    if (!rows.length) {
      return { day, recorded: false, ok: null, message: `OpenAI has no cost rows for ${day} yet. Nothing was recorded; try again later.` };
    }
    if (rows.some((row) => Date.parse(row.occurred_at) !== start.getTime())) throw new Error("OpenAI returned a cost bucket outside the requested day.");
    const syncedAt = new Date().toISOString();
    const { error: recordError } = await db.rpc("record_code_closed_day_costs", { p_actor: context.userId, p_day: day, p_rows: rows, p_synced_at: syncedAt });
    if (recordError) throw new Error(`The closed-day report for ${day} could not be recorded (the day may not be closed long enough yet).`);
    const { data: result, error } = await db.rpc("reconcile_code_provider_day", { p_actor: context.userId, p_day: day, p_tolerance_usd: 0.01 });
    if (error || !result) throw new Error(`The report for ${day} was recorded, but reconciliation failed.`);
    return {
      day,
      recorded: true,
      ok: result.ok === true,
      message: result.ok === true
        ? `OpenAI's report for ${day} matches the gateway ($${Number(result.provider_usd).toFixed(2)} reported, $${Number(result.gateway_usd).toFixed(2)} admitted).`
        : `OpenAI reported $${Number(result.unaccounted_usd).toFixed(2)} more than the gateway admitted on ${day}. The Emergency Stop is engaged.`,
    };
  });

async function requireOwner(ctx: {
  supabase: { rpc: (f: "my_role") => PromiseLike<{ data: unknown }> };
}) {
  const { data } = await ctx.supabase.rpc("my_role");
  if (data !== "owner") throw new Error("Only the owner can manage CODE safety controls.");
}

async function fetchGithub<T>(path: string): Promise<T> {
  const token = process.env["CODE_GITHUB_TOKEN"];
  if (!token)
    throw new Error(
      "CODE target verification is blocked: the backend GitHub credential is unavailable.",
    );
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Jackboy",
  });
  headers.set("Authorization", ["Bearer", token].join(" "));
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`CODE target verification failed with GitHub status ${response.status}.`);
  return (await response.json()) as T;
}

export const getCodeSafetySettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const { getCodeSafetyState } = await import("./code-safety.server");
    const safetyState = await getCodeSafetyState();
    const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const { data, error } = await db
      .from("code_runtime_controls")
      .select("*")
      .eq("singleton", true)
      .single();
    if (error || !data)
      throw new Error(
        "CODE safety controls are unavailable; apply the pending database migration.",
      );
    const targets = parseCodeTargets(data.allowed_targets);
    const now = new Date();
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    ).toISOString();
    const [today, hour] = await Promise.all([
      db.from("code_usage_events").select("cost_usd").gte("occurred_at", startOfDay),
      db
        .from("code_usage_events")
        .select("cost_usd")
        .gte("occurred_at", new Date(Date.now() - 3_600_000).toISOString()),
    ]);
    if (today.error || hour.error)
      throw new Error("CODE provider spending records could not be read.");
    const sum = (rows: { cost_usd: number }[] | null) =>
      (rows ?? []).reduce((total, row) => total + Number(row.cost_usd), 0);
    const spendTodayUsd = sum(today.data);
    const spendLastHourUsd = sum(hour.data);
    const meterFresh =
      data.provider_hard_cap_verified &&
      !!data.provider_usage_at &&
      Date.now() - Date.parse(data.provider_usage_at) <= 5 * 60_000 &&
      Date.parse(data.provider_usage_at) <= Date.now() + 30_000;
    return {
      targets,
      checkedAt: new Date().toISOString(),
      enabled: data.enabled,
      killSwitch: data.kill_switch,
      activeRequestId: data.active_request_id,
      activeRunId: data.active_run_id,
      consecutiveFailures: data.consecutive_failures,
      perTaskReserveUsd: data.per_task_reserve_usd === null || data.per_task_reserve_usd === undefined ? null : Number(data.per_task_reserve_usd),
      dailySpendLimitUsd: data.daily_spend_limit_usd,
      spendTodayUsd,
      spendLastHourUsd,
      providerBudgetEnforced: data.provider_hard_cap_verified,
      meterFresh,
      usageSpike: data.usage_spike,
      pausedReason: data.paused_reason,
      cancellationStatus: data.cancellation_status,
      providerCostsSyncedAt: data.provider_costs_synced_at,
      maxDailySpendUsd: CODE_DAILY_SPEND_LIMIT_USD,
      // Read-only report of the cumulative guard; null until its reviewed migration is applied.
      totalSpendGuard: safetyState.totalSpendGuard,
      // Live gateway-ledger meter; null until its reviewed migration is applied.
      spendMeter: safetyState.spendMeter,
    };
  });

/** Retired: allow-list changes go only through the fresh-passkey "Add to CODE" flow (code-onboarding.functions.ts). */
export const setCodeSafetyTarget = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    throw new Error("Pin changes need your passkey: use Add to CODE on the project page.");
  });

export const setCodeDailySpendLimit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      limitUsd: z
        .number()
        .min(0.01)
        .max(CODE_DAILY_SPEND_LIMIT_USD)
        .refine((value) => Number.isInteger(value * 100), "Use increments of one cent."),
    }),
  )
  .handler(async ({ context, data }) => {
    await requireOwner(context);
    const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const { error } = await db
      .from("code_runtime_controls")
      .update({
        daily_spend_limit_usd: data.limitUsd,
        updated_at: new Date().toISOString(),
      })
      .eq("singleton", true);
    if (error) throw new Error("CODE daily spending limit could not be saved.");
    const { error: auditError } = await db.from("audit_logs").insert({
      actor: context.userId,
      action: "code.spend_limit_changed",
      detail: { daily_spend_limit_usd: data.limitUsd },
      outcome: "ok",
    });
    if (auditError)
      throw new Error("CODE spend limit changed but its audit record could not be written.");
    return { limitUsd: data.limitUsd };
  });

export const syncCodeProviderCosts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const { costReportSettings, fetchOpenAICostRows } = await import("./openai-costs.server");
    const settings = costReportSettings();
    if (!settings) {
      throw new Error(
        "Provider cost sync is unavailable: configure OPENAI_ADMIN_KEY, OPENAI_CODE_PROJECT_ID, and OPENAI_CODE_API_KEY_ID on the server.",
      );
    }
    const now = new Date();
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const rows: OpenAICostRow[] = await fetchOpenAICostRows(settings, startOfDay, now);
    if (!rows.length) {
      throw new Error(
        "OpenAI returned no attributable cost rows for the current UTC day; CODE remains blocked.",
      );
    }
    if (rows.some((row) => Date.parse(row.occurred_at) !== startOfDay.getTime())) {
      throw new Error("OpenAI returned a cost bucket outside the current UTC day.");
    }

    const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const syncedAt = now.toISOString();
    const { error: recordError } = await db.rpc("record_code_provider_costs", {
      p_actor: context.userId,
      p_rows: rows,
      p_synced_at: syncedAt,
    });
    if (recordError)
      throw new Error("Provider costs, sync time, and audit record could not be committed.");
    // Holds stay counted if reconciliation fails, which is the fail-closed direction.
    const { data: settledHolds, error: reconcileError } = await db.rpc(
      "reconcile_code_spend_reservations",
      { p_actor: context.userId },
    );
    const total = rows.reduce((sum, row) => sum + row.cost_usd, 0);
    return {
      reportedCostUsd: total,
      bucketCount: rows.length,
      syncedAt,
      enforcement: "reporting_only" as const,
      reconciledReservations: reconcileError ? null : Number(settledHolds ?? 0),
    };
  });

export const engageCodeKillSwitch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(grantInput)
  .handler(async ({ data, context }) => {
    await requireOwner(context);
    await (await import("./passkey.server")).consumeGrant(data.grantId, context.userId, "global_pause", GLOBAL_PAUSE_ON);
    const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const { data: stop, error } = await db.rpc("engage_code_kill_switch", {
      p_actor: context.userId,
    });
    if (error || !stop?.length)
      throw new Error("CODE emergency stop could not be atomically persisted.");
    const current = stop[0];
    if (!current) throw new Error("CODE emergency stop returned no state.");
    let cancellation: "not_needed" | "requested" | "unavailable" = "not_needed";
    if (current.active_request_id && current.active_run_id) {
      const { data: action } = await db
        .from("action_requests")
        .select("resources")
        .eq("id", current.active_request_id)
        .maybeSingle();
      const repo =
        action?.resources &&
        typeof action.resources === "object" &&
        !Array.isArray(action.resources)
          ? (action.resources as Record<string, unknown>)["repo"]
          : null;
      const token = process.env["CODE_GITHUB_TOKEN"];
      if (typeof repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(repo) && token) {
        try {
          const headers = new Headers({
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Jackboy",
          });
          headers.set("Authorization", ["Bearer", token].join(" "));
          const response = await fetch(
            `https://api.github.com/repos/${repo}/actions/runs/${current.active_run_id}/cancel`,
            {
              method: "POST",
              headers,
              redirect: "manual",
              signal: AbortSignal.timeout(10_000),
            },
          );
          cancellation = response.ok ? "requested" : "unavailable";
        } catch {
          cancellation = "unavailable";
        }
      } else {
        cancellation = "unavailable";
      }
    }
    const { error: statusError } = await db.rpc("record_code_cancellation_status", {
      p_actor: context.userId,
      p_status:
        cancellation === "not_needed"
          ? "not_needed"
          : cancellation === "requested"
            ? "requested"
            : "unverified",
    });
    if (statusError)
      throw new Error("CODE stop was engaged, but its cancellation status could not be recorded.");
    const after = await readControls(db);
    return { killSwitch: true, cancellation, codeEnabled: after.enabled, globalPaused: after.killSwitch };
  });

export const checkCodeCancellation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const { data: controls, error } = await db
      .from("code_runtime_controls")
      .select("kill_switch, active_request_id, active_run_id")
      .eq("singleton", true)
      .single();
    if (error || !controls?.kill_switch)
      throw new Error("Engage the CODE emergency stop before checking cancellation.");
    if (!controls.active_request_id || !controls.active_run_id) {
      const { error: statusError } = await db.rpc("record_code_cancellation_status", {
        p_actor: context.userId,
        p_status: "not_needed",
      });
      if (statusError) throw new Error("CODE cancellation status could not be recorded.");
      return { status: "not_needed" as const };
    }

    const { data: action } = await db
      .from("action_requests")
      .select("resources")
      .eq("id", controls.active_request_id)
      .maybeSingle();
    const repo =
      action?.resources && typeof action.resources === "object" && !Array.isArray(action.resources)
        ? (action.resources as Record<string, unknown>)["repo"]
        : null;
    const token = process.env["CODE_GITHUB_TOKEN"];
    if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !token) {
      const { error: statusError } = await db.rpc("record_code_cancellation_status", {
        p_actor: context.userId,
        p_status: "unverified",
      });
      if (statusError) throw new Error("Unverified CODE stop status could not be audited.");
      return { status: "unverified" as const };
    }

    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Jackboy",
    });
    headers.set("Authorization", ["Bearer", token].join(" "));
    let status: "pending" | "requested" | "confirmed" | "completed" | "unverified";
    try {
      const runResponse = await fetch(
        `https://api.github.com/repos/${repo}/actions/runs/${controls.active_run_id}`,
        { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) },
      );
      if (!runResponse.ok) throw new Error("GitHub run status could not be retrieved.");
      const run = (await runResponse.json()) as { status?: unknown; conclusion?: unknown };
      const reconciliation = classifyGithubCancellationState(run.status, run.conclusion);
      if (reconciliation === "confirmed" || reconciliation === "completed") {
        status = reconciliation;
      } else if (reconciliation === "active") {
        const cancelResponse = await fetch(
          `https://api.github.com/repos/${repo}/actions/runs/${controls.active_run_id}/cancel`,
          { method: "POST", headers, redirect: "manual", signal: AbortSignal.timeout(10_000) },
        );
        if (!cancelResponse.ok) status = "unverified";
        else status = "requested";
      } else {
        status = "unverified";
      }
    } catch {
      status = "unverified";
    }
    const { error: statusError } = await db.rpc("record_code_cancellation_status", {
      p_actor: context.userId,
      p_status: status,
    });
    if (statusError) throw new Error("CODE cancellation result could not be recorded.");
    return { status };
  });

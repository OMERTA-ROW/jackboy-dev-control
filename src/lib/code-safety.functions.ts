import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { CODE_WORKFLOW } from "./code";
import {
  classifyGithubCancellationState,
  CODE_DAILY_SPEND_LIMIT_USD,
  parseCodeTargets,
} from "./code-safety";
import type { OpenAICostRow } from "./openai-costs";

const REPOSITORY = "OMERTA-ROW/jackboy-dev-control";

/** Read-only readiness: never dispatches, reads secret values, or changes GitHub configuration. */
export const getCodePrerequisites = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const [secrets, workflow] = await Promise.allSettled([
      fetchGithub<{ secrets: { name: string }[]; total_count: number }>("/environments/CODE/secrets?per_page=100"),
      fetchGithub<{ sha: string }>(`/contents/.github/workflows/${CODE_WORKFLOW}?ref=main`),
    ]);
    return {
      repository: REPOSITORY,
      ref: "main",
      secretNamesVerified: secrets.status === "fulfilled",
      openaiKeyPresent: secrets.status === "fulfilled" ? secrets.value.secrets.some((s) => s.name === "OPENAI_API_KEY") : null,
      secretCheckError: secrets.status === "rejected" ? "GitHub refused CODE environment secret-name access; owner must verify OPENAI_API_KEY in GitHub." : null,
      workflowSha: workflow.status === "fulfilled" && /^[a-f0-9]{40}$/.test(workflow.value.sha) ? workflow.value.sha : null,
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
  });
  headers.set("Authorization", ["Bearer", token].join(" "));
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
    headers,
    redirect: "error",
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
    await getCodeSafetyState();
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
      enabled: data.enabled,
      killSwitch: data.kill_switch,
      activeRequestId: data.active_request_id,
      activeRunId: data.active_run_id,
      consecutiveFailures: data.consecutive_failures,
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
    };
  });

export const setCodeSafetyTarget = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireOwner(context);
    const [repository, workflow, workflowFile] = await Promise.all([
      fetchGithub<{ default_branch: string }>(""),
      fetchGithub<{ state: string }>(`/actions/workflows/${CODE_WORKFLOW}`),
      fetchGithub<{ sha: string }>(`/contents/.github/workflows/${CODE_WORKFLOW}?ref=main`),
    ]);
    if (
      repository.default_branch !== "main" ||
      workflow.state !== "active" ||
      !/^[a-f0-9]{40}$/.test(workflowFile.sha)
    ) {
      throw new Error(
        "The requested CODE repository, main branch, or active workflow could not be verified.",
      );
    }
    const targets = parseCodeTargets({
      [REPOSITORY]: { ref: "main", workflowSha: workflowFile.sha },
    });
    const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const { error } = await db
      .from("code_runtime_controls")
      .update({
        allowed_targets: targets,
        updated_at: new Date().toISOString(),
      })
      .eq("singleton", true);
    if (error) throw new Error("CODE repository allowlist could not be saved.");
    const { error: auditError } = await db.from("audit_logs").insert({
      actor: context.userId,
      action: "code.target_allowlist_updated",
      detail: { allowed_targets: targets },
      outcome: "ok",
    });
    if (auditError)
      throw new Error("CODE allowlist changed but its audit record could not be written.");
    return { targets };
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
    const adminKey = process.env["OPENAI_ADMIN_KEY"];
    const projectId = process.env["OPENAI_CODE_PROJECT_ID"];
    const apiKeyId = process.env["OPENAI_CODE_API_KEY_ID"];
    if (!adminKey || !projectId || !apiKeyId || projectId.length > 200 || apiKeyId.length > 200) {
      throw new Error(
        "Provider cost sync is unavailable: configure OPENAI_ADMIN_KEY, OPENAI_CODE_PROJECT_ID, and OPENAI_CODE_API_KEY_ID on the server.",
      );
    }
    const { parseOpenAICostPage } = await import("./openai-costs");

    const now = new Date();
    const startOfDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const params = new URLSearchParams({
      start_time: String(Math.floor(startOfDay.getTime() / 1000)),
      end_time: String(Math.floor(now.getTime() / 1000)),
      bucket_width: "1d",
      limit: "180",
    });
    params.append("project_ids", projectId);
    params.append("api_key_ids", apiKeyId);
    params.append("group_by", "project_id");
    params.append("group_by", "api_key_id");
    params.append("group_by", "line_item");
    const headers = new Headers({ Accept: "application/json" });
    headers.set("Authorization", `Bearer ${adminKey}`);
    const rows: OpenAICostRow[] = [];
    const pages = new Set<string>();
    let page: string | null = null;
    for (let count = 0; count < 10; count++) {
      if (page) {
        if (pages.has(page)) throw new Error("OpenAI costs pagination repeated a cursor.");
        pages.add(page);
        params.set("page", page);
      }
      const response = await fetch(`https://api.openai.com/v1/organization/costs?${params}`, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401) {
        throw new Error("OpenAI cost sync credential was rejected (HTTP 401).");
      }
      if (response.status === 403) {
        throw new Error(
          "OpenAI cost sync credential lacks organization usage permission (HTTP 403).",
        );
      }
      if (!response.ok) throw new Error(`OpenAI cost sync failed (HTTP ${response.status}).`);
      const parsed = parseOpenAICostPage(await response.json(), projectId, apiKeyId);
      rows.push(...parsed.rows);
      if (!parsed.hasMore) break;
      page = parsed.nextPage;
      if (count === 9) throw new Error("OpenAI costs pagination exceeded the safety limit.");
    }
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
  .handler(async ({ context }) => {
    await requireOwner(context);
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
          });
          headers.set("Authorization", ["Bearer", token].join(" "));
          const response = await fetch(
            `https://api.github.com/repos/${repo}/actions/runs/${current.active_run_id}/cancel`,
            {
              method: "POST",
              headers,
              redirect: "error",
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
    return { killSwitch: true, cancellation };
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
    });
    headers.set("Authorization", ["Bearer", token].join(" "));
    let status: "pending" | "requested" | "confirmed" | "completed" | "unverified";
    try {
      const runResponse = await fetch(
        `https://api.github.com/repos/${repo}/actions/runs/${controls.active_run_id}`,
        { headers, redirect: "error", signal: AbortSignal.timeout(10_000) },
      );
      if (!runResponse.ok) throw new Error("GitHub run status could not be retrieved.");
      const run = (await runResponse.json()) as { status?: unknown; conclusion?: unknown };
      const reconciliation = classifyGithubCancellationState(run.status, run.conclusion);
      if (reconciliation === "confirmed" || reconciliation === "completed") {
        status = reconciliation;
      } else if (reconciliation === "active") {
        const cancelResponse = await fetch(
          `https://api.github.com/repos/${repo}/actions/runs/${controls.active_run_id}/cancel`,
          { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(10_000) },
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

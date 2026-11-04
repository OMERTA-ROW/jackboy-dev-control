import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { untyped } from "./untyped-db";
import { verifyOwner } from "./chat.server";
import { CODE_ACTION } from "./code";

const REPO = "OMERTA-ROW/jackboy-dev-control";
const MAX_ROWS = 500;
type State = "PASS" | "FAIL" | "BLOCKED";
type Evidence = {
  status: State;
  source: string;
  observedAt: string;
  coverage: "complete" | "partial" | "unavailable";
  values: Record<string, unknown> | null;
  reason: string | null;
};
const db = untyped(supabaseAdmin);

// Observation only: no safety helper, RPC, dispatch, cancellation or provider call.
export async function collectSafetyStatus() {
  const observedAt = new Date().toISOString();
  const evidence: Record<string, Evidence> = {};
  const blocked = (source: string, reason: string): Evidence => ({
    status: "BLOCKED",
    source,
    observedAt,
    coverage: "unavailable",
    values: null,
    reason,
  });
  async function read(
    name: string,
    table: string,
    columns: string,
    evaluate: (rows: Record<string, unknown>[]) => {
      safe: boolean;
      values: Record<string, unknown>;
    },
    single = false,
    project = false,
  ) {
    try {
      let query = db
        .from(table)
        .select(columns, { count: "exact" })
        .limit(MAX_ROWS + 1);
      if (project) query = query.eq("github_repo", REPO);
      const { data: rawData, error, count } = await query;
      const data = rawData as unknown as Record<string, unknown>[] | null;
      if (error || !Array.isArray(data) || (single && data.length !== 1)) {
        evidence[name] = blocked(table, "Source unavailable or required singleton missing.");
        return;
      }
      if (count === null || count !== data.length || data.length > MAX_ROWS) {
        evidence[name] = {
          ...blocked(table, "Inventory exceeds bounded read; full pagination required."),
          coverage: "partial",
        };
        return;
      }
      const required = columns.split(",");
      if (data.some((row) => required.some((key) => !(key in row)))) {
        evidence[name] = blocked(table, "Required source fields are missing.");
        return;
      }
      const booleans = required.filter((key) =>
        [
          "autopilot_enabled",
          "autopilot",
          "dev_enabled",
          "enabled",
          "paused",
          "kill_switch",
          "singleton",
        ].includes(key),
      );
      if (data.some((row) => booleans.some((key) => typeof row[key] !== "boolean"))) {
        evidence[name] = blocked(table, "Required control values are invalid.");
        return;
      }
      const result = evaluate(data);
      evidence[name] = {
        status: result.safe ? "PASS" : "FAIL",
        source: table,
        observedAt,
        coverage: "complete",
        values: result.values,
        reason: result.safe ? null : "Observed state does not meet paused acceptance conditions.",
      };
    } catch {
      evidence[name] = blocked(table, "Source could not be read or validated.");
    }
  }
  await read(
    "masterAutopilot",
    "update_writer_settings",
    "id,autopilot_enabled",
    (rows) => ({
      safe: rows[0]?.["autopilot_enabled"] === false,
      values: { off: rows[0]?.["autopilot_enabled"] === false },
    }),
    true,
  );
  await read(
    "project",
    "owner_projects",
    "id,github_repo,autopilot,dev_enabled",
    (rows) => ({
      safe: rows[0]?.["autopilot"] === false && rows[0]?.["dev_enabled"] === false,
      values: {
        autopilot: rows[0]?.["autopilot"],
        backgroundDevelopment: rows[0]?.["dev_enabled"],
      },
    }),
    true,
    true,
  );
  await read(
    "foundrySchedule",
    "foundry_schedule",
    "id,enabled,paused",
    (rows) => ({
      safe: rows[0]?.["enabled"] === false && rows[0]?.["paused"] === true,
      values: { enabled: rows[0]?.["enabled"], paused: rows[0]?.["paused"] },
    }),
    true,
  );
  await read(
    "code",
    "code_runtime_controls",
    "singleton,enabled,kill_switch,active_request_id",
    (rows) => ({
      safe:
        rows[0]?.["enabled"] === false &&
        rows[0]?.["kill_switch"] === true &&
        rows[0]?.["active_request_id"] === null,
      values: {
        enabled: rows[0]?.["enabled"],
        emergencyStop: rows[0]?.["kill_switch"],
        activeRequestPresent: rows[0]?.["active_request_id"] !== null,
      },
    }),
    true,
  );
  await read(
    "requests",
    "action_requests",
    "id,action,status,runner_claimed_at,runner_published_at",
    (rows) => {
      const code = rows.filter((r) => r["action"] === CODE_ACTION);
      const pending = code.filter((r) => !["denied", "expired"].includes(String(r["status"])));
      return {
        safe: pending.length === 0,
        values: { total: code.length, requiringLifecycleReview: pending.length },
      };
    },
  );
  await read("omniQueue", "omni_jobs", "id,status", (rows) => {
    const active = rows.filter(
      (r) => !["completed", "failed", "cancelled"].includes(String(r["status"])),
    );
    return {
      safe: active.length === 0,
      values: { total: rows.length, requiringApprovalReview: active.length },
    };
  });
  await read("foundryQueue", "foundry_tasks", "id,state", (rows) => {
    const active = rows.filter(
      (r) =>
        !["discovered", "awaiting_approval", "blocked", "rejected", "failed", "completed"].includes(
          String(r["state"]),
        ),
    );
    return {
      safe: active.length === 0,
      values: { total: rows.length, potentiallyExecuting: active.length },
    };
  });
  // These integrations are not available through a complete authoritative read contract.
  evidence["schedules"] = blocked(
    "platform + cron + GitHub schedules",
    "Complete platform scheduler inventory is not connected; Foundry is only one schedule source.",
  );
  evidence["workers"] = blocked(
    "all worker platforms + GitHub branches",
    "Complete external worker/run inventory and owner approval correlation are unavailable.",
  );
  evidence["audit"] = blocked(
    "audit_logs + immutable execution events",
    "Access logging does not prove historical event completeness or approval correlation.",
  );
  evidence["metering"] = blocked(
    "provider enforcement",
    "No verified strict daily cap or actual runner credential/project association.",
  );
  const stale = Date.now() - Date.parse(observedAt) > 60_000;
  if (stale)
    for (const key of Object.keys(evidence))
      evidence[key] = blocked(evidence[key]!.source, "Snapshot expired while collecting sources.");
  return {
    repository: REPO,
    environment: "runtime database; deployment identity requires independent verification",
    observedAt,
    expiresAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
    status: Object.values(evidence).some((e) => e.status === "FAIL")
      ? ("FAIL" as const)
      : ("BLOCKED" as const),
    activationApproved: false,
    evidence,
  };
}

export async function handleSafetyStatus(request: Request): Promise<Response> {
  const reply = (data: unknown, status: number) =>
    Response.json(data, {
      status,
      headers: { "Cache-Control": "no-store, private", Pragma: "no-cache" },
    });
  let actor: string | null = null;
  try {
    actor = await verifyOwner(request);
  } catch {
    /* deny closed */
  }
  // Only fixed fields enter the audit record. Never log bearer, URL query or errors.
  try {
    const { error } = await db.from("audit_logs").insert({
      actor,
      action: "safety_status.access",
      detail: { repository: REPO },
      outcome: actor ? "authorized_attempt" : "denied",
    });
    if (error) throw new Error("audit unavailable");
  } catch {
    return reply({ status: "BLOCKED", error: "Safety access audit unavailable." }, 503);
  }
  if (!actor) return reply({ error: "Owner sign-in required." }, 401);
  if (request.method !== "GET" || new URL(request.url).search)
    return reply({ error: "Only an unparameterized GET is supported." }, 400);
  try {
    return reply(await collectSafetyStatus(), 200);
  } catch {
    return reply({ status: "BLOCKED", error: "Safety observation unavailable." }, 503);
  }
}

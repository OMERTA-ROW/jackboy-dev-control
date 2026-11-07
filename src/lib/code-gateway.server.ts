import { randomUUID } from "node:crypto";
import { supabaseAdmin as typedDb } from "@/integrations/supabase/client.server";
import { untyped } from "./untyped-db";
import { CODE_ACTION, type CodeScope } from "./code";
import { verifyGithubActionsToken, verifyWorkflowRun } from "./code-runner-auth.server";
import {
  GatewayError,
  createCodeGateway,
  parsePriceTable,
  type GatewayDeps,
  type Identity,
} from "./code-gateway";

const db = untyped(typedDb);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{40}$/;

// The only reader of the CODE provider credential. It must never be set on a runner, workflow or
// client; tests/code-gateway-isolation.test.mjs enforces that no other source file references it.
const PROVIDER_KEY_ENV = "CODE_PROVIDER_API_KEY";
const PROVIDER_ORIGIN = "https://api.openai.com";

export function codeGatewayProviderKeyPresent(): boolean {
  return !!process.env[PROVIDER_KEY_ENV];
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`${name} failed`);
  return data as T;
}

// Binds the caller to the one approved, claimed, running CODE task: GitHub Actions OIDC identity plus
// the owner-approved scope, then the database re-verifies the active request and run on admission.
async function authenticate(request: Request): Promise<Identity> {
  const parts = (request.headers.get("authorization") ?? "").split(" ");
  const bearer = parts.length === 2 && parts[0]?.toLowerCase() === "bearer" ? parts[1] : undefined;
  const url = new URL(request.url);
  const headerId = request.headers.get("x-code-request-id");
  const queryIds = url.searchParams.getAll("request_id");
  if (queryIds.length > 1 || (headerId && queryIds[0] && headerId !== queryIds[0])) {
    throw new GatewayError(401, "Ambiguous CODE request identity.");
  }
  // The pinned Codex proxy forwards Authorization but has no custom-header input.
  // The query contains only the public request identifier, never a credential.
  const requestId = headerId ?? queryIds[0] ?? "";
  if (!bearer || !UUID.test(requestId))
    throw new GatewayError(401, "GitHub Actions identity required.");
  const claims = await verifyGithubActionsToken(bearer);
  const { data: row } = await db
    .from("action_requests")
    .select(
      "action, status, revoked_at, runner_claimed_at, runner_run_id, runner_run_attempt, resources, requested_by",
    )
    .eq("id", requestId)
    .single();
  const scope = row?.resources as unknown as (CodeScope & { baseSha?: string }) | undefined;
  if (
    !row ||
    row.action !== CODE_ACTION ||
    row.status !== "allowed" ||
    row.revoked_at ||
    !row.runner_claimed_at ||
    String(row.runner_run_id) !== claims.run_id ||
    String(row.runner_run_attempt) !== claims.run_attempt ||
    !scope?.repo ||
    !scope.ref ||
    !SHA.test(scope.workflowSha) ||
    !SHA.test(scope.baseSha ?? "")
  ) {
    throw new GatewayError(403, "CODE task is not authorised for provider access.");
  }
  const { data: owner, error: ownerError } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", row.requested_by)
    .eq("role", "owner")
    .maybeSingle();
  if (ownerError || !owner) {
    throw new GatewayError(403, "CODE owner authorization is unavailable.");
  }
  await verifyWorkflowRun(
    claims,
    scope.repo,
    scope.ref,
    scope.workflowSha,
    scope.baseSha!,
    "execute",
  );
  return { requestId, runId: Number(claims.run_id) };
}

export function productionGatewayDeps(): GatewayDeps {
  return {
    authenticate,
    admit: (identity, callKey, model, ceilingUsd) =>
      rpc<string>("admit_code_provider_call", {
        p_request_id: identity.requestId,
        p_run_id: identity.runId,
        p_call_key: callKey,
        p_model: model,
        p_ceiling_usd: ceilingUsd,
      }).then((id) => {
        if (!id) throw new GatewayError(409, "CODE provider call blocked.");
        return id;
      }),
    dispatch: (callId) => rpc<void>("dispatch_code_provider_call", { p_call_id: callId }),
    abort: (callId, reason) =>
      rpc<void>("abort_code_provider_call", { p_call_id: callId, p_reason: reason }),
    settle: (callId, actualUsd, providerRequestId) =>
      rpc<boolean>("settle_code_provider_call", {
        p_call_id: callId,
        p_actual_usd: actualUsd,
        p_provider_request_id: providerRequestId,
      }).then(() => undefined),
    markUnknown: (callId, reason) =>
      rpc<void>("mark_code_provider_call_unknown", { p_call_id: callId, p_reason: reason }),
    isStopped: async (identity) => {
      const { data, error } = await db
        .from("code_runtime_controls")
        .select(
          "enabled, kill_switch, stop_requested_at, active_request_id, active_run_id, cancellation_status",
        )
        .eq("singleton", true)
        .single();
      return (
        !!error ||
        !data ||
        data.enabled !== true ||
        data.kill_switch !== false ||
        !!data.stop_requested_at ||
        data.active_request_id !== identity.requestId ||
        String(data.active_run_id) !== String(identity.runId) ||
        data.cancellation_status !== "not_needed"
      );
    },
    providerKey: () => process.env[PROVIDER_KEY_ENV] || undefined,
    prices: () => parsePriceTable(process.env["CODE_GATEWAY_PRICES"]),
    perCallCapUsd: () => {
      const cap = Number(process.env["CODE_GATEWAY_PER_CALL_CAP_USD"]);
      if (!Number.isFinite(cap) || cap <= 0 || cap > 5) {
        throw new GatewayError(503, "CODE per-call spending cap is not configured.");
      }
      return cap;
    },
    upstream: (path, init) => fetch(`${PROVIDER_ORIGIN}${path}`, init),
    newKey: () => randomUUID().replaceAll("-", ""),
  };
}

export const handleCodeProviderRequest = (request: Request) =>
  createCodeGateway(productionGatewayDeps())(request);

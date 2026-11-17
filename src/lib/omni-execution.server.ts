import { isIP } from "node:net";
import { z } from "zod";
import { hmacHex, safeEqual } from "./omni-link";
import { LINK_CONTRACT, LINK_PATH, UUID, linkRequestUrl, verifyRequest } from "./omni-session";
import { boundedBody, loadEffectiveApproval } from "./omni-session.server";

const controlInput = z
  .object({
    action: z.literal("execution-control"),
    projectId: z.string().uuid(),
    audience: z.enum(["mothership", "executor"]),
    operation: z.enum([
      "connect",
      "configure",
      "verify",
      "arm",
      "disarm",
      "unconfigure",
      "revoke",
      "safety",
      "authorize",
      "lease",
      "claim",
      "permission",
      "finish",
    ]),
    args: z
      .object({
        operationId: z.string().uuid().optional(),
        expiresAt: z.string().datetime({ offset: true }).optional(),
        jobId: z.string().uuid().optional(),
        planSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        release: z
          .string()
          .regex(/^[A-Za-z0-9_.-]{1,80}$/)
          .optional(),
        outcome: z.enum(["completed", "failed", "cancelled"]).optional(),
      })
      .strict(),
  })
  .strict();

type Store = (
  owner: string,
  project: string,
  approval: string,
  operation: string,
  args: Record<string, unknown>,
) => Promise<unknown>;
const store: Store = async (owner, project, approval, operation, args) => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = (await import("./untyped-db")).untyped(supabaseAdmin);
  const result = await db.rpc("omni_execution_control", {
    _owner: owner,
    _project: project,
    _approval: approval,
    _op: operation,
    _a: args,
  });
  if (result.error || !result.data) throw new Error("Execution authority refused");
  return result.data;
};

/** Uses durable nonce authorization even for safety reads while the Kill Switch is engaged. */
async function claimNonce(client: string, nonce: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = (await import("./untyped-db")).untyped(supabaseAdmin);
  const { error } = await db.rpc("claim_omni_execution_nonce", { _client: client, _nonce: nonce });
  if (error) throw new Error("Request replay or nonce store unavailable");
}

export async function handleExecutionControl(
  request: Request,
  dependencies: {
    env?: Record<string, string | undefined>;
    approval?: { approvalId: string; expiresAt: string };
    store?: Store;
    nonce?: typeof claimNonce;
    verify?: () => Promise<{ passed: boolean; release: string }>;
    inspect?: () => Promise<{ release: string; enabled: boolean; reviewedRelease: string | null }>;
    readiness?: () => Promise<void>;
    cancel?: typeof deliverOmniCancellations;
  } = {},
) {
  const env = dependencies.env ?? process.env;
  const plain = (status: number, error: string) =>
    Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
  let stage = "request";
  try {
    const url = linkRequestUrl(request, env);
    if (!url || url.pathname !== LINK_PATH || request.method !== "POST" || url.search)
      return plain(400, "https_post_required");
    const raw = await boundedBody(request);
    const input = controlInput.parse(JSON.parse(raw));
    const secret =
      env[
        input.audience === "executor" ? "OMNI_EXECUTOR_PERMISSION_SECRET" : "OMNI_LINK_HMAC_SECRET"
      ];
    const token =
      request.headers.get("authorization")?.match(/^Bearer ([a-zA-Z0-9_-]{32,256})$/)?.[1] ?? "";
    const expectedToken =
      input.audience === "executor"
        ? env["OMNI_EXECUTOR_PERMISSION_TOKEN"]
        : env["OMNI_LINK_BOOTSTRAP_KEY"];
    const client = env["OMNI_LINK_CLIENT_ID"] ?? "";
    const owner = env["OMNI_LINK_OWNER_ID"] ?? "";
    // Same checks, same order, same short-circuit as before; only the name of the first failing
    // check is kept so an operator can diagnose it. It carries no values.
    const failure =
      !secret || secret.length < 32
        ? "secret_missing_or_short"
        : !expectedToken
          ? "token_not_configured"
          : !UUID.test(owner)
            ? "owner_id_invalid"
            : request.headers.get("x-omni-client") !== client
              ? "client_mismatch"
              : input.projectId !== env["OMNI_LINK_PROJECT_ID"]
                ? "project_mismatch"
                : !safeEqual(token, expectedToken)
                  ? "token_mismatch"
                  : !(await verifyRequest(secret, token, request.headers, raw))
                    ? "signature_mismatch"
                    : null;
    if (failure) {
      // The reason is returned only while OMNI_AUTH_REASON_DEBUG is "true"; it is off by default.
      return env["OMNI_AUTH_REASON_DEBUG"] === "true"
        ? Response.json(
            { error: "authentication_failed", reason: failure },
            { status: 401, headers: { "Cache-Control": "no-store" } },
          )
        : plain(401, "authentication_failed");
    }
    if (!secret) return plain(401, "authentication_failed"); // unreachable; narrows the type
    if (
      input.audience === "executor" &&
      !["claim", "permission", "finish"].includes(input.operation)
    )
      return plain(403, "project_or_action_denied");
    if (
      input.audience === "mothership" &&
      ["claim", "permission", "finish"].includes(input.operation)
    )
      return plain(403, "project_or_action_denied");
    stage = "nonce";
    await (dependencies.nonce ?? claimNonce)(client, request.headers.get("x-omni-nonce")!);
    stage = "approval";
    const approval = dependencies.approval ?? (await loadEffectiveApproval(env));
    if (!UUID.test(approval.approvalId)) return plain(403, "approval_unavailable");
    const approvalExpiry = Date.parse(approval.expiresAt);
    const authorized =
      env["OMNI_LINK_ENABLED"] === "true" &&
      Number.isFinite(approvalExpiry) &&
      approvalExpiry > Date.now() &&
      approvalExpiry <= Date.now() + 24 * 60 * 60_000;
    if (
      [
        "connect",
        "configure",
        "verify",
        "arm",
        "authorize",
        "lease",
        "claim",
        "permission",
      ].includes(input.operation) &&
      !authorized
    )
      return plain(403, "approval_expired_or_link_disabled");
    let args: Record<string, unknown> = input.args;
    if (
      input.operation === "connect" &&
      (!input.args.expiresAt || Date.parse(input.args.expiresAt) > Date.parse(approval.expiresAt))
    )
      return plain(403, "approval_expired");
    if (input.operation === "verify") {
      stage = "verify";
      const verification = await (dependencies.verify ?? verifyExecutor)();
      args = { release: verification.release, passed: verification.passed };
    }
    if (input.operation === "arm" && input.args.release !== env["OMNI_AUTONOMY_REVIEWED_RELEASE"])
      return plain(403, "release_unreviewed");
    if (input.operation === "configure") {
      stage = "readiness";
      await (
        dependencies.readiness ??
        (async () => (await import("./code-safety.functions")).assertCodeConfigurationReady())
      )();
    }
    if (input.operation === "configure" || input.operation === "arm") {
      stage = "inspect";
      const executor = await (dependencies.inspect ?? inspectExecutor)();
      if (
        executor.release !== env["OMNI_AUTONOMY_REVIEWED_RELEASE"] ||
        executor.reviewedRelease !== executor.release ||
        (input.operation === "arm" && !executor.enabled)
      )
        return plain(403, "release_unreviewed");
      args = { ...args, release: executor.release };
    }
    stage = "store";
    const state = await (dependencies.store ?? store)(
      owner,
      input.projectId,
      approval.approvalId,
      input.operation,
      { ...args, clientId: client },
    );
    stage = "respond";
    if (["disarm", "unconfigure", "revoke"].includes(input.operation)) {
      const cancellation = await (dependencies.cancel ?? deliverOmniCancellations)();
      if (cancellation.unavailable) return plain(503, "cancellation_unverified");
      const fresh = await (dependencies.store ?? store)(
        owner,
        input.projectId,
        approval.approvalId,
        "safety",
        { clientId: client },
      );
      return signedState(fresh, secret);
    }
    return signedState(state, secret);
    async function signedState(state: unknown, signingSecret: string) {
      state = {
        ...z.object({}).passthrough().parse(state),
        executorOrigin: env["OMNI_EXECUTOR_ORIGIN"] ?? null,
      };
      if (!authorized) {
        const current = z.object({}).passthrough().parse(state);
        state = { ...current, executionReady: false, allowed: false, connected: false };
      }
      const nonce = request.headers.get("x-omni-nonce")!;
      const body = JSON.stringify({ contract: LINK_CONTRACT, requestNonce: nonce, state });
      return new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Omni-Proof": await hmacHex(
            signingSecret,
            `${LINK_CONTRACT}\nresponse\n${nonce}\n200\n${body}`,
          ),
        },
      });
    }
  } catch (error) {
    // Only while OMNI_AUTH_REASON_DEBUG is "true": name the stage and error text, with any long
    // token-like run masked. Off by default; the default response is unchanged.
    if (env["OMNI_AUTH_REASON_DEBUG"] !== "true")
      return plain(503, "execution_control_unavailable");
    const text = (error instanceof Error ? error.message : "non-error thrown")
      .replace(/[A-Za-z0-9_-]{24,}/g, "[masked]")
      .slice(0, 160);
    return Response.json(
      { error: "execution_control_unavailable", reason: `${stage}: ${text}` },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function executorRequest(
  operation: "self-test" | "inspect" | "cancel",
  args: Record<string, unknown>,
) {
  const origin = process.env["OMNI_EXECUTOR_ORIGIN"];
  const secret = process.env["OMNI_EXECUTOR_CONTROL_SECRET"];
  if (!origin || !secret || secret.length < 32) throw new Error("Executor is not configured");
  const url = new URL(origin);
  const internalOrigin = "http://omni-autonomous-executor.railway.internal:8080";
  const isInternalExecutor = origin === internalOrigin || origin === `${internalOrigin}/`;
  const hostname = url.hostname;
  const labels = hostname.split(".");
  const isStagingExecutor =
    !!process.env["OMNI_EXECUTOR_STAGING_ORIGIN"] &&
    origin === process.env["OMNI_EXECUTOR_STAGING_ORIGIN"] &&
    origin === url.origin &&
    url.protocol === "https:" &&
    !url.port &&
    !isIP(hostname) &&
    hostname.length <= 253 &&
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    ) &&
    !labels.includes("localhost");
  if (
    (!isInternalExecutor &&
      !isStagingExecutor &&
      (url.protocol !== "https:" || !url.hostname.endsWith(".up.railway.app"))) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Executor must use the exact private origin or a separate Railway HTTPS service",
    );
  if (
    origin === process.env["OMNI_SANDBOX_ORIGIN"] ||
    origin === process.env["OMNI_REMOTE_RUNNER_ORIGIN"]
  )
    throw new Error("Executor must not share a legacy runner");
  const { signedExecutorRequest } = await import("./omni-executor-client");
  return signedExecutorRequest(origin, secret, operation, args);
}

async function inspectExecutor() {
  return z
    .object({
      release: z.literal("omni-bounded-plan-2"),
      enabled: z.boolean(),
      reviewedRelease: z.string().nullable(),
    })
    .parse(await executorRequest("inspect", {}));
}

async function verifyExecutor() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("automation_policy")
    .select("paused")
    .eq("id", 1)
    .maybeSingle();
  if (error || data?.paused !== false) throw new Error("Kill Switch prohibits diagnostics");
  return z
    .object({ passed: z.boolean(), release: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/) })
    .parse(await executorRequest("self-test", {}));
}

/** Durable stop requests are committed before attempting network cancellation. */
export async function deliverOmniCancellations() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = (await import("./untyped-db")).untyped(supabaseAdmin);
  const pending = await db
    .from("omni_execution_jobs")
    .select("id,plan_sha256,claimed_at")
    .eq("state", "cancel_requested")
    .limit(10);
  if (pending.error) throw new Error("OMNI cancellation outbox unavailable");
  let unavailable = 0;
  for (const job of pending.data ?? []) {
    try {
      // Cancellation commits before claim can succeed; an unclaimed job never reached execution.
      if (job.claimed_at !== null) {
        z.object({ cancelled: z.literal(true) }).parse(
          await executorRequest("cancel", { jobId: job.id, planSha256: job.plan_sha256 }),
        );
      }
      const updated = await db.rpc("omni_execution_cancel_ack", {
        _job: job.id,
        _hash: job.plan_sha256,
      });
      if (updated.error) throw new Error("Cancellation acknowledgement could not be stored");
    } catch {
      unavailable++;
    }
  }
  return { pending: pending.data?.length ?? 0, unavailable };
}

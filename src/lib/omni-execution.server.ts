import { isIP } from "node:net";
import { z } from "zod";
import { hmacHex, safeEqual } from "./omni-link";
import { LINK_CONTRACT, LINK_PATH, UUID, linkRequestUrl, verifyRequest } from "./omni-session";
import { boundedBody, loadEffectiveApproval } from "./omni-session.server";
import { omniFailureStopReason, type FailureHistory } from "./omni-failure-stop";
import {
  classifyAuthorityError,
  classifyReadinessError,
  executorVerificationFresh,
  failureDetail,
  type ExecutionStage,
} from "./omni-execution-refusal";
import { redact } from "./site-log";

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
  if (result.error || !result.data)
    throw new ExecutionAuthorityError(result.error?.message ?? "", result.error?.code ?? null);
  return result.data;
};

/** Carries the database's own refusal text so it can be classified and audited (never returned). */
export class ExecutionAuthorityError extends Error {
  constructor(
    readonly dbMessage: string,
    readonly code: string | null,
  ) {
    super(dbMessage ? `Execution authority refused: ${dbMessage}` : "Execution authority refused");
    this.name = "ExecutionAuthorityError";
  }
}

type ConnectionRow = { verifiedAt: string | null; executorRelease: string | null } | null;
/** Read-only: the recorded executor verification for this project's connection. */
async function readConnection(project: string): Promise<ConnectionRow> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = (await import("./untyped-db")).untyped(supabaseAdmin);
  const { data, error } = await db
    .from("omni_execution_connections")
    .select("verified_at, executor_release")
    .eq("project_id", project)
    .maybeSingle();
  if (error) throw new Error("Execution connection state unavailable");
  return data
    ? { verifiedAt: data.verified_at ?? null, executorRelease: data.executor_release ?? null }
    : null;
}

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
    failures?: (client: string, project: string) => Promise<FailureHistory>;
    audit?: typeof auditRefusal;
    connection?: (project: string) => Promise<ConnectionRow>;
    now?: () => number;
  } = {},
) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? Date.now;
  let stage: ExecutionStage = "request";
  // Before authentication succeeds, refusals stay unsigned so the secret is never an oracle.
  // After it, every refusal is a signed omni.link/v2 reply carrying the real reason.
  let authed: { secret: string; nonce: string; operation: string; project: string } | null = null;
  const plain = async (
    status: number,
    error: string,
    diagnostic?: { stage: ExecutionStage; detail: ReturnType<typeof failureDetail> },
  ) => {
    if (!authed)
      return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
    const audit = dependencies.audit ?? auditRefusal;
    await (
      diagnostic
        ? audit(authed.project, authed.operation, error, diagnostic)
        : audit(authed.project, authed.operation, error)
    ).catch(() => undefined);
    return signedRefusal(authed.secret, authed.nonce, status, error, diagnostic?.stage);
  };
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
    authed = {
      secret,
      nonce: request.headers.get("x-omni-nonce")!,
      operation: input.operation,
      project: input.projectId,
    };
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
      stage = "executor";
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
      stage = "executor";
      const executor = await (dependencies.inspect ?? inspectExecutor)();
      if (
        executor.release !== env["OMNI_AUTONOMY_REVIEWED_RELEASE"] ||
        executor.reviewedRelease !== executor.release ||
        (input.operation === "arm" && !executor.enabled)
      )
        return plain(403, "release_unreviewed");
      args = { ...args, release: executor.release };
      if (input.operation === "configure") {
        // Step 10 needs a fresh recorded verification of this exact release (connect clears it).
        // The database enforces the same rule; checking here names the real reason.
        stage = "verification";
        const row = await (dependencies.connection ?? readConnection)(input.projectId);
        if (!executorVerificationFresh(row, executor.release, now()))
          return plain(409, "executor_verification_required");
      }
    }
    if (input.operation === "authorize") {
      // Two-failure stop: no new bounded job after two failed jobs in a row since the owner's
      // newest authorization. Unreadable history fails closed. Existing jobs are not touched.
      stage = "failure_stop";
      const history = await (dependencies.failures ?? readFailureHistory)(client, input.projectId);
      const stop = omniFailureStopReason(history);
      if (stop) {
        if (!dependencies.failures) await auditFailureStop(owner, input.projectId, stop);
        return plain(403, stop);
      }
    }
    stage = "authority";
    const state = await (dependencies.store ?? store)(
      owner,
      input.projectId,
      approval.approvalId,
      input.operation,
      { ...args, clientId: client },
    );
    stage = "respond";
    if (["disarm", "unconfigure", "revoke"].includes(input.operation)) {
      stage = "cancellation";
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
  } catch (failure) {
    const detail = failureDetail(failure, redact);
    // Nonsecret server-side trace so the failing stage is visible in the runtime logs.
    console.error("[omni.execution] refused", stage, detail.name, detail.code ?? "no_code", detail.message);
    if (!authed && stage === "request" && isMalformed(failure))
      return plain(400, "invalid_request");
    if (stage === "readiness") {
      const refusal = classifyReadinessError(detail.message);
      if (refusal) return plain(refusal.status, refusal.error, { stage, detail });
    }
    if (stage === "authority" && failure instanceof ExecutionAuthorityError) {
      const refusal = classifyAuthorityError(failure.dbMessage);
      if (refusal) return plain(refusal.status, refusal.error, { stage, detail });
    }
    // Only while OMNI_AUTH_REASON_DEBUG is "true": also return the stage and error text, with any
    // long token-like run masked (unsigned, as before). Off by default.
    if (env["OMNI_AUTH_REASON_DEBUG"] === "true") {
      await plain(503, "execution_control_unavailable", { stage, detail });
      const text = (failure instanceof Error ? failure.message : "non-error thrown")
        .replace(/[A-Za-z0-9_-]{24,}/g, "[masked]")
        .slice(0, 160);
      return Response.json(
        { error: "execution_control_unavailable", reason: `${stage}: ${text}` },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    return plain(503, "execution_control_unavailable", { stage, detail });
  }
}

function isMalformed(failure: unknown) {
  return failure instanceof SyntaxError || failure instanceof z.ZodError;
}

export async function signedRefusal(
  secret: string,
  nonce: string,
  status: number,
  error: string,
  stage?: ExecutionStage,
) {
  const body = JSON.stringify(
    stage
      ? { contract: LINK_CONTRACT, requestNonce: nonce, error, stage }
      : { contract: LINK_CONTRACT, requestNonce: nonce, error },
  );
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Omni-Proof": await hmacHex(secret, `${LINK_CONTRACT}\nresponse\n${nonce}\n${status}\n${body}`),
    },
  });
}

/** One audit row per refused authenticated execution-control call. Failures also record the
 * stage and a short redacted error so the real cause is traceable; nothing secret is stored. */
async function auditRefusal(
  project: string,
  operation: string,
  reason: string,
  diagnostic?: { stage: ExecutionStage; detail: ReturnType<typeof failureDetail> },
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = (await import("./untyped-db")).untyped(supabaseAdmin);
  await db.from("audit_logs").insert({
    actor: null,
    action: "omni.execution.refused",
    detail: diagnostic
      ? { project_id: project, operation, reason, stage: diagnostic.stage, error: diagnostic.detail }
      : { project_id: project, operation, reason },
    outcome: "refused",
  });
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

/** Newest owner authorization time and recent finished bounded jobs; any read error returns null. */
async function readFailureHistory(client: string, project: string): Promise<FailureHistory> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = (await import("./untyped-db")).untyped(supabaseAdmin);
    const auth = await db
      .from("omni_autonomy_authorizations")
      .select("created_at")
      .eq("client_id", client)
      .eq("project_id", project)
      .order("created_at", { ascending: false })
      .limit(1);
    if (auth.error) return null;
    const since = (auth.data?.[0]?.created_at as string | undefined) ?? null;
    let query = db
      .from("omni_execution_jobs")
      .select("state,finished_at")
      .eq("project_id", project)
      .in("state", ["completed", "failed"]);
    if (since) query = query.gt("finished_at", since);
    const jobs = await query.order("finished_at", { ascending: false }).limit(20);
    if (jobs.error || !Array.isArray(jobs.data)) return null;
    return { since, jobs: jobs.data as { state: string; finished_at: string | null }[] };
  } catch {
    return null;
  }
}

/** Best effort: an audit failure never changes the refusal. */
async function auditFailureStop(owner: string, project: string, reason: string) {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = (await import("./untyped-db")).untyped(supabaseAdmin);
    await db.from("audit_logs").insert({
      actor: UUID.test(owner) ? owner : null,
      action: "omni.execution.failure_stop",
      detail: { project_id: project, reason },
      outcome: "blocked",
    });
  } catch {
    /* audit is best effort */
  }
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

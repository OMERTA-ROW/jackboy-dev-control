// Server-only handler for POST /api/public/omni-handoff/v1 (see omni-handoff-v1.ts for the rules).
// Writes only: a single-use nonce, one queued omni_jobs row (+ task mapping) via the
// service-only omni_handoff_create RPC, and site_log audit rows. Never contacts OMNI.
import { z } from "zod";
import { hmacHex, safeEqual } from "./omni-link";
import {
  HANDOFF_CONTRACT,
  HANDOFF_MAX_BODY_BYTES,
  HANDOFF_PATH,
  handoffClockOk,
  handoffConfig,
  handoffPublicStatus,
  handoffRequestSchema,
  handoffResponseInput,
  handoffSigningInput,
  sha256Hex,
  type HandoffCreate,
  type HandoffRequest,
  type HandoffSettings,
} from "./omni-handoff-v1";

export type HandoffRefusal =
  | "kill_switch_on"
  | "digest_mismatch"
  | "project_not_authorized"
  | "task_conflict"
  | "owner_unavailable"
  | "invalid_request";
export type HandoffCreateOutcome =
  | { outcome: "created" | "existing"; jobId: string; status: string }
  | { outcome: "refused"; reason: HandoffRefusal };
export type HandoffAudit = {
  action: "omni.handoff.create" | "omni.handoff.status" | "omni.handoff.refused";
  summary: string;
  status: "ok" | "pending" | "blocked" | "info";
  projectId?: string | null;
  repo?: string | null;
  detail: Record<string, unknown>;
};
export type HandoffDeps = {
  /** Returns "replay" when the nonce was already used. Throws when storage is unavailable. */
  claimNonce(nonce: string, clientId: string): Promise<"ok" | "replay">;
  /** Plain-language reason when work must not start (fail closed), else null. */
  killSwitch(): Promise<string | null>;
  create(input: HandoffCreate, clientId: string): Promise<HandoffCreateOutcome>;
  status(taskId: string, clientId: string): Promise<{ jobId: string; status: string } | null>;
  audit(entry: HandoffAudit): Promise<void>;
};

async function readLimitedBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") || "0");
  if (declared > HANDOFF_MAX_BODY_BYTES) throw new RangeError("Body too large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  let bytes = 0;
  let expired = false;
  const chunks: Uint8Array[] = [];
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 2000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > HANDOFF_MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError("Body too large");
      }
      chunks.push(value);
    }
    if (expired) throw new Error("Body timeout");
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

const plain = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

export async function handleOmniHandoffV1(
  request: Request,
  settings: HandoffSettings | null = handoffConfig(process.env),
  deps: HandoffDeps = databaseDeps(),
  now: () => number = Date.now,
): Promise<Response> {
  // Disabled: no audit row, so an anonymous caller cannot write to the permanent log.
  if (!settings) return plain(503, "handoff_disabled");

  const client = request.headers.get("x-jackboy-client") || "";
  const knownClient = safeEqual(client, settings.clientId);
  // Unauthenticated refusals are audited only when the configured client is named,
  // so random internet traffic cannot flood site_log; everything else goes to worker logs.
  const refusePreAuth = async (status: number, reason: string) => {
    if (knownClient)
      await deps.audit({
        action: "omni.handoff.refused",
        status: "blocked",
        summary: `Mothership handoff refused before authentication: ${reason}`,
        detail: { reason, client: settings.clientId, stage: "authentication" },
      });
    else console.warn(`omni-handoff refused: ${reason}`);
    return plain(
      status,
      reason === "body_too_large" ? reason : status === 401 ? "authentication_failed" : reason,
    );
  };

  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.protocol !== "https:" ||
    url.pathname !== HANDOFF_PATH ||
    url.search
  )
    return refusePreAuth(400, "https_post_required");
  const timestamp = request.headers.get("x-jackboy-timestamp") || "";
  const nonce = request.headers.get("x-jackboy-nonce") || "";
  const signature = request.headers.get("x-jackboy-signature") || "";
  if (request.headers.get("x-jackboy-contract") !== HANDOFF_CONTRACT || !knownClient)
    return refusePreAuth(401, "bad_client_or_contract");
  if (!handoffClockOk(timestamp, now())) return refusePreAuth(401, "clock_skew");
  if (!/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature))
    return refusePreAuth(401, "malformed_signature_headers");
  let raw: string;
  try {
    raw = await readLimitedBody(request);
  } catch (error) {
    return error instanceof RangeError
      ? refusePreAuth(413, "body_too_large")
      : refusePreAuth(400, "invalid_body");
  }
  const expected = await hmacHex(
    settings.secret,
    handoffSigningInput(client, timestamp, nonce, raw),
  );
  if (!safeEqual(signature, expected)) return refusePreAuth(401, "bad_signature");
  try {
    if ((await deps.claimNonce(nonce, settings.clientId)) === "replay")
      return refusePreAuth(401, "nonce_replay");
  } catch {
    return plain(503, "handoff_unavailable");
  }

  // Authenticated from here on: every response is signed and bound to the request nonce.
  const signed = async (status: number, payload: Record<string, unknown>) => {
    const body = JSON.stringify({ contract: HANDOFF_CONTRACT, requestNonce: nonce, ...payload });
    const proof = await hmacHex(settings.secret, handoffResponseInput(nonce, status, body));
    return new Response(body, {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Jackboy-Proof": proof,
      },
    });
  };
  const refuse = async (
    status: number,
    reason: string,
    input?: { action?: string; taskId?: string; projectId?: string; repo?: string; kind?: string },
  ) => {
    await deps.audit({
      action: "omni.handoff.refused",
      status: "blocked",
      summary: `Mothership handoff ${input?.action ?? "request"} refused: ${reason}`,
      projectId: input?.projectId ?? null,
      repo: input?.repo ?? null,
      detail: {
        reason,
        client: settings.clientId,
        requestAction: input?.action ?? null,
        taskId: input?.taskId ?? null,
        projectId: input?.projectId ?? null,
        kind: input?.kind ?? null,
      },
    });
    return signed(status, { error: reason });
  };

  let input: HandoffRequest;
  try {
    input = handoffRequestSchema.parse(JSON.parse(raw));
  } catch {
    return refuse(400, "invalid_request");
  }

  if (input.action === "status") {
    let found: { jobId: string; status: string } | null;
    try {
      found = await deps.status(input.taskId, settings.clientId);
    } catch {
      return refuse(503, "handoff_unavailable", input);
    }
    if (!found) return refuse(404, "task_not_found", input);
    await deps.audit({
      action: "omni.handoff.status",
      status: "info",
      summary: `Mothership read handoff status for Jackboy job ${found.jobId}: ${found.status}`,
      detail: {
        client: settings.clientId,
        taskId: input.taskId,
        jobId: found.jobId,
        status: found.status,
      },
    });
    return signed(200, { jackboyJobId: found.jobId, status: found.status });
  }

  // create
  let paused: string | null;
  try {
    paused = await deps.killSwitch();
  } catch {
    paused = "Kill Switch state could not be read";
  }
  if (paused) return refuse(423, "kill_switch_on", input);
  if (!safeEqual(await sha256Hex(input.instructions), input.digest))
    return refuse(422, "digest_mismatch", input);
  let outcome: HandoffCreateOutcome;
  try {
    outcome = await deps.create(input, settings.clientId);
  } catch {
    return refuse(503, "handoff_unavailable", input);
  }
  if (outcome.outcome === "refused") {
    const status = {
      kill_switch_on: 423,
      digest_mismatch: 422,
      task_conflict: 409,
      invalid_request: 400,
    }[outcome.reason as string];
    return refuse(status ?? 403, outcome.reason, input);
  }
  const duplicate = outcome.outcome === "existing";
  await deps.audit({
    action: "omni.handoff.create",
    status: "pending",
    summary: duplicate
      ? `Mothership repeated handoff ${input.taskId}; returned existing Jackboy job ${outcome.jobId} (not sent to OMNI)`
      : `Mothership handoff queued as Jackboy job ${outcome.jobId} (not sent to OMNI; owner approval still required)`,
    projectId: input.projectId,
    repo: input.repo,
    detail: {
      client: settings.clientId,
      taskId: input.taskId,
      jobId: outcome.jobId,
      projectId: input.projectId,
      kind: input.kind,
      duplicate,
    },
  });
  return signed(duplicate ? 200 : 201, { jackboyJobId: outcome.jobId, status: outcome.status });
}

const createResult = z.union([
  z.object({
    outcome: z.enum(["created", "existing"]),
    jobId: z.string().uuid(),
    status: z.string(),
  }),
  z.object({
    outcome: z.literal("refused"),
    reason: z.enum([
      "kill_switch_on",
      "digest_mismatch",
      "project_not_authorized",
      "task_conflict",
      "owner_unavailable",
      "invalid_request",
    ]),
  }),
]);

function databaseDeps(): HandoffDeps {
  const admin = async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { untyped } = await import("./untyped-db");
    return untyped(supabaseAdmin);
  };
  return {
    async claimNonce(nonce, clientId) {
      const db = await admin();
      const { error } = await db.from("omni_handoff_nonces").insert({ nonce, client_id: clientId });
      if (!error) return "ok";
      if (error.code === "23505") return "replay";
      throw new Error("Nonce storage unavailable.");
    },
    async killSwitch() {
      const { readGlobalPause } = await import("./global-pause.server");
      return readGlobalPause();
    },
    async create(input, clientId) {
      const db = await admin();
      const { data, error } = await db.rpc("omni_handoff_create", {
        _task: input.taskId,
        _client: clientId,
        _project: input.projectId,
        _repo: input.repo,
        _kind: input.kind,
        _instructions: input.instructions,
        _digest: input.digest,
      });
      if (error) throw new Error("Handoff transaction failed.");
      return createResult.parse(data);
    },
    async status(taskId, clientId) {
      const db = await admin();
      const task = await db
        .from("omni_handoff_tasks")
        .select("job_id")
        .eq("task_id", taskId)
        .eq("client_id", clientId)
        .maybeSingle();
      if (task.error) throw new Error("Handoff lookup failed.");
      const jobId = (task.data as { job_id?: string } | null)?.job_id;
      if (!jobId) return null;
      const [job, v3] = await Promise.all([
        db.from("omni_jobs").select("status").eq("id", jobId).maybeSingle(),
        db.from("omni_dispatch_v3_jobs").select("status").eq("job_id", jobId).maybeSingle(),
      ]);
      if (job.error || v3.error || !job.data) throw new Error("Handoff lookup failed.");
      return {
        jobId,
        status: handoffPublicStatus(
          (job.data as { status?: string }).status,
          (v3.data as { status?: string } | null)?.status,
        ),
      };
    },
    async audit(entry) {
      const { logSite } = await import("./site-log.server");
      await logSite({
        actor: "evolution-mothership",
        action: entry.action,
        category: "activity",
        status: entry.status,
        summary: entry.summary,
        project_id: entry.projectId ?? null,
        repo: entry.repo ?? null,
        detail: entry.detail,
      });
    },
  };
}

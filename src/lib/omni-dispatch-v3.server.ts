import { request as httpsRequest } from "node:https";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { dispatchPayloadDigest } from "./omni-dispatch-digest";
import { wireKind } from "./omni-handoff-auth";
import { hmacHex, safeEqual } from "./omni-link";
import { logSiteStrict } from "./site-log.server";
import { untyped } from "./untyped-db";

const CONTRACT = "jackboy.dispatch/v3";
const CALLBACK_CONTRACT = "jackboy.dispatch-callback/v3";
const DISPATCH_PATH = "/api/public/jackboy/dispatch";
const CALLBACK_PATH = "/api/public/omni/callback";
const MAX_ENVELOPE_BYTES = 8192;
const MAX_PAYLOAD_BYTES = 6144;
const MAX_OUTPUT_BYTES = 6144;
const MAX_SUMMARY_CHARS = 500;
const statuses = [
  "approved",
  "quarantined",
  "running",
  "completed",
  "failed",
  "expired",
  "cancelled",
] as const;
const resultStatuses = ["completed", "failed"] as const;

const scopeSchema = z
  .object({
    ownerId: z.string().uuid(),
    projectId: z.string().uuid(),
    grantId: z.string().uuid(),
    jobId: z.string().uuid(),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .max(200),
    kind: z.enum(["build", "test"]),
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type Scope = z.infer<typeof scopeSchema>;
type Action = "submit" | "status" | "cancel";
type Result = {
  passed: boolean;
  summary: string;
  output: string;
  truncated: boolean;
};
type Callback = Omit<Scope, "kind"> & {
  contract: typeof CALLBACK_CONTRACT;
  status: "quarantined" | "cancelled" | "running" | "expired" | (typeof resultStatuses)[number];
  result?: Result | undefined;
};
type ClientConfig = {
  origin: string;
  ca: string | Buffer;
  clientId: string;
  secret: string;
};
type DispatchResponse = { status: number; body: string; proof: string };
type DispatchTransport = (
  url: URL,
  options: { ca: string | Buffer; headers: Record<string, string>; timeout: number },
  body: string,
) => Promise<DispatchResponse>;
type Grant = Scope & { instructions: string; expiresAt: string };
type Authorize = (scope: Scope, action: Action, expiresAt?: number) => Promise<void>;
type Audit = (event: string, scope: Scope, status?: string) => Promise<void>;

const resultSchema = z
  .object({
    passed: z.boolean(),
    summary: z.string().refine((value) => Array.from(value).length <= MAX_SUMMARY_CHARS),
    output: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= MAX_OUTPUT_BYTES),
    truncated: z.boolean(),
  })
  .strict();
const callbackSchema = z
  .object({
    contract: z.literal(CALLBACK_CONTRACT),
    ownerId: z.string().uuid(),
    projectId: z.string().uuid(),
    grantId: z.string().uuid(),
    jobId: z.string().uuid(),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .max(200),
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["quarantined", "cancelled", "running", "expired", ...resultStatuses]),
    result: resultSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasResult = resultStatuses.includes(value.status as (typeof resultStatuses)[number]);
    if (hasResult !== Boolean(value.result))
      context.addIssue({
        code: "custom",
        message: "Only completed and failed callbacks include a result.",
      });
    if (value.status === "completed" && value.result?.passed !== true)
      context.addIssue({ code: "custom", message: "Completed results must pass." });
    if (value.status === "failed" && value.result?.passed !== false)
      context.addIssue({ code: "custom", message: "Failed results must not pass." });
  });

function assertNoDuplicateKeys(raw: string) {
  let index = 0;
  const whitespace = () => {
    while (/\s/.test(raw[index] ?? "") && index < raw.length) index++;
  };
  const stringToken = () => {
    const start = index++;
    while (index < raw.length) {
      const character = raw[index++]!;
      if (character === "\\") index++;
      else if (character === '"') return JSON.parse(raw.slice(start, index)) as string;
    }
    throw new Error("Invalid JSON string.");
  };
  const value = (): void => {
    whitespace();
    if (raw[index] === '"') {
      stringToken();
      return;
    }
    if (raw[index] === "{") {
      index++;
      whitespace();
      const keys = new Set<string>();
      if (raw[index] === "}") {
        index++;
        return;
      }
      for (;;) {
        whitespace();
        if (raw[index] !== '"') throw new Error("Invalid JSON object key.");
        const key = stringToken();
        if (keys.has(key)) throw new Error("Duplicate JSON object key.");
        keys.add(key);
        whitespace();
        if (raw[index++] !== ":") throw new Error("Invalid JSON object.");
        value();
        whitespace();
        const separator = raw[index++]!;
        if (separator === "}") return;
        if (separator !== ",") throw new Error("Invalid JSON object.");
      }
    }
    if (raw[index] === "[") {
      index++;
      whitespace();
      if (raw[index] === "]") {
        index++;
        return;
      }
      for (;;) {
        value();
        whitespace();
        const separator = raw[index++]!;
        if (separator === "]") return;
        if (separator !== ",") throw new Error("Invalid JSON array.");
      }
    }
    while (index < raw.length && !/[\s,[\]{}]/.test(raw[index]!)) index++;
    if (index === 0) throw new Error("Invalid JSON value.");
  };
  value();
  whitespace();
  if (index !== raw.length) throw new Error("Trailing JSON data.");
}

function hasUnpairedSurrogate(value: string) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function assertValidUnicode(value: unknown): void {
  if (typeof value === "string" && hasUnpairedSurrogate(value))
    throw new Error("Invalid Unicode string.");
  if (Array.isArray(value)) {
    for (const item of value) assertValidUnicode(item);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertValidUnicode(key);
      assertValidUnicode(item);
    }
  }
}

function callbackSettings() {
  if (process.env["JACKBOY_DISPATCH_V3_ENABLED"] !== "true") return null;
  const clientId = process.env["OMNI_DISPATCH_CALLBACK_CLIENT_ID"] || "";
  const secret = process.env["OMNI_DISPATCH_CALLBACK_SECRET"] || "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientId) || secret.length < 32) return null;
  return { clientId, secret };
}

function dispatchConfig(): ClientConfig {
  if (process.env["JACKBOY_DISPATCH_V3_ENABLED"] !== "true")
    throw new Error("Scoped OMNI dispatch v3 is disabled.");
  const origin = process.env["OMNI_DISPATCH_ORIGIN"] || "";
  const caFile = process.env["OMNI_DISPATCH_CA_FILE"] || "";
  const clientId = process.env["OMNI_DISPATCH_CLIENT_ID"] || "";
  const secret = process.env["OMNI_DISPATCH_HMAC_SECRET"] || "";
  const url = new URL(origin);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !caFile ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(clientId) ||
    secret.length < 32
  )
    throw new Error("Scoped OMNI dispatch v3 configuration is incomplete.");
  return { origin, ca: Buffer.alloc(0), clientId, secret };
}

function sendHttps(
  url: URL,
  options: { ca: string | Buffer; headers: Record<string, string>; timeout: number },
  body: string,
): Promise<DispatchResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      { method: "POST", ca: options.ca, timeout: options.timeout, headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_ENVELOPE_BYTES) request.destroy(new Error("Dispatch response too large."));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8"),
            proof:
              typeof res.headers["x-jackboy-proof"] === "string"
                ? res.headers["x-jackboy-proof"]
                : "",
          }),
        );
      },
    );
    request.on("timeout", () => request.destroy(new Error("Dispatch timed out.")));
    request.on("error", reject);
    request.end(body);
  });
}

export class OmniDispatchV3Client {
  private readonly config: ClientConfig;
  private readonly authorize: Authorize;
  private readonly audit: Audit;
  private readonly transport: DispatchTransport;

  constructor(
    config: ClientConfig,
    authorize: Authorize,
    audit: Audit,
    transport: DispatchTransport = sendHttps,
  ) {
    this.config = config;
    this.authorize = authorize;
    this.audit = audit;
    this.transport = transport;
    const url = new URL(config.origin);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !config.ca.length ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(config.clientId) ||
      config.secret.length < 32
    )
      throw new Error("Invalid dispatch TLS or credential configuration.");
  }

  async send(action: Action, scope: Scope, payload?: string, expiresAt?: number) {
    const validated = scopeSchema.parse(scope);
    if (action === "submit") {
      if (typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES)
        throw new Error("Dispatch payload exceeds 6144 UTF-8 bytes.");
      if (
        !Number.isSafeInteger(expiresAt) ||
        (expiresAt as number) <= Math.floor(Date.now() / 1000) ||
        (expiresAt as number) > Math.floor(Date.now() / 1000) + 30 * 60
      )
        throw new Error("Dispatch expiry must be within the next 30 minutes.");
    } else if (payload !== undefined || expiresAt !== undefined) {
      throw new Error("Status and cancel requests cannot include payload or expiry.");
    }

    const nonce = crypto.randomUUID().replaceAll("-", "");
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      contract: CONTRACT,
      action,
      ...validated,
      ...(action === "submit" ? { payload, expiresAt } : {}),
    });
    if (Buffer.byteLength(body, "utf8") > MAX_ENVELOPE_BYTES)
      throw new Error("Dispatch request exceeds 8192 UTF-8 bytes.");
    await this.audit(`request_${action}`, validated);
    await this.authorize(validated, action, expiresAt);
    const signature = await hmacHex(
      this.config.secret,
      `${CONTRACT}\nPOST\n${DISPATCH_PATH}\n${this.config.clientId}\n${timestamp}\n${nonce}\n${body}`,
    );
    await this.authorize(validated, action, expiresAt);
    const response = await this.transport(
      new URL(DISPATCH_PATH, this.config.origin),
      {
        ca: this.config.ca,
        timeout: 5000,
        headers: {
          "content-type": "application/json",
          "x-jackboy-client": this.config.clientId,
          "x-jackboy-timestamp": timestamp,
          "x-jackboy-nonce": nonce,
          "x-jackboy-signature": signature,
        },
      },
      body,
    );
    const expectedStatus = action === "submit" ? 202 : 200;
    if (response.status !== expectedStatus)
      throw new Error(`Dispatch failed with HTTP ${response.status}.`);
    const proof = await hmacHex(
      this.config.secret,
      `${CONTRACT}\nresponse\n${nonce}\n${response.status}\n${response.body}`,
    );
    if (!safeEqual(response.proof, proof)) throw new Error("Invalid dispatch response proof.");
    const responseSchema = z
      .object({
        contract: z.literal(CONTRACT),
        requestNonce: z.literal(nonce),
        job: z.object({ id: z.literal(validated.jobId), status: z.enum(statuses) }).strict(),
      })
      .strict();
    const result = responseSchema.parse(JSON.parse(response.body));
    await this.audit(`result_${result.job.status}`, validated, result.job.status);
    return result.job;
  }
}

async function loadGrant(actor: string, jobId: string, grantId: string): Promise<Grant> {
  const db = untyped(supabaseAdmin);
  const response = await db.rpc("omni_dispatch_grant_action", {
    _op: "check",
    _actor: actor,
    _job: jobId,
    _grant: grantId,
  });
  if (response.error) throw new Error("Dispatch authorization could not be verified.");
  const result = z
    .object({
      valid: z.literal(true),
      id: z.string().uuid(),
      expiresAt: z.string(),
      ownerId: z.string().uuid(),
      projectId: z.string().uuid(),
      jobId: z.string().uuid(),
      repo: z.string(),
      kind: z.enum(["code", "test"]),
      instructions: z.string(),
    })
    .parse(response.data);
  if (result.ownerId !== actor || result.jobId !== jobId || result.id !== grantId)
    throw new Error("Dispatch grant scope mismatch.");
  return {
    ownerId: result.ownerId,
    projectId: result.projectId,
    grantId: result.id,
    jobId: result.jobId,
    repo: result.repo,
    kind: wireKind(result.kind),
    payloadDigest: await dispatchPayloadDigest({
      ...result,
      kind: wireKind(result.kind),
      grantId: result.id,
    }),
    instructions: result.instructions,
    expiresAt: result.expiresAt,
  };
}

async function loadExistingScope(actor: string, jobId: string, grantId: string): Promise<Scope> {
  const db = untyped(supabaseAdmin);
  const response = await db.rpc("omni_dispatch_v3_action", {
    _op: "read",
    _actor: actor,
    _job: jobId,
    _grant: grantId,
    _project: null,
    _repo: null,
    _kind: null,
    _digest: null,
    _expires: null,
    _action: null,
  });
  if (response.error) throw new Error("Previously authorized v3 dispatch scope is unavailable.");
  return scopeSchema.parse(response.data);
}

export async function executeOmniV3Receipt(
  actor: string,
  jobId: string,
  grantId: string,
  action: Action,
) {
  const { readFile } = await import("node:fs/promises");
  const config = dispatchConfig();
  const db = untyped(supabaseAdmin);
  let scope: Scope;
  let payload: string | undefined;
  let expiresAt: number | undefined;
  if (action === "submit") {
    const { isOmniVerified } = await import("./omni-link.server");
    if (!(await isOmniVerified(actor)))
      throw new Error(
        "OMNI's live link is not verified right now. Check the connection, then try again.",
      );
    const grant = await loadGrant(actor, jobId, grantId);
    scope = scopeSchema.parse({
      ownerId: grant.ownerId,
      projectId: grant.projectId,
      grantId: grant.grantId,
      jobId: grant.jobId,
      repo: grant.repo,
      kind: grant.kind,
      payloadDigest: grant.payloadDigest,
    });
    payload = grant.instructions;
    if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES)
      throw new Error("Dispatch payload exceeds 6144 UTF-8 bytes.");
    expiresAt = Math.min(
      Math.floor(Date.parse(grant.expiresAt) / 1000),
      Math.floor(Date.now() / 1000) + 30 * 60,
    );
    if (expiresAt <= Math.floor(Date.now() / 1000)) throw new Error("Dispatch grant has expired.");
  } else {
    scope = await loadExistingScope(actor, jobId, grantId);
  }
  const ca = await readFile(process.env["OMNI_DISPATCH_CA_FILE"] || "");
  const client = new OmniDispatchV3Client(
    { ...config, ca },
    async (candidate, intent, expiry) => {
      if (intent === "submit") {
        const response = await db.rpc("omni_dispatch_v3_action", {
          _op: "prepare",
          _actor: actor,
          _job: jobId,
          _grant: grantId,
          _project: candidate.projectId,
          _repo: candidate.repo,
          _kind: candidate.kind,
          _digest: candidate.payloadDigest,
          _expires: new Date((expiry as number) * 1000).toISOString(),
          _action: intent,
        });
        if (response.error || !response.data)
          throw new Error("Current owner grant could not be revalidated for v3 signing.");
        return;
      }
      const response = await db.rpc("omni_dispatch_v3_action", {
        _op: intent === "cancel" ? "request_cancel" : "authorize_status",
        _actor: actor,
        _job: jobId,
        _grant: grantId,
        _project: candidate.projectId,
        _repo: candidate.repo,
        _kind: candidate.kind,
        _digest: candidate.payloadDigest,
        _expires: null,
        _action: intent,
      });
      if (response.error || !response.data)
        throw new Error("Previously authorized v3 dispatch scope is unavailable.");
    },
    async (event, current, status) => {
      await logSiteStrict({
        actor,
        action: `omni.dispatch.v3.${event}`,
        category: "delivery",
        status: event.startsWith("result_") ? "ok" : "pending",
        summary: `Owner ${event.replaceAll("_", " ")} for v3 ${current.kind} dispatch`,
        project_id: current.projectId,
        detail: { jobId, grantId, action, status: status ?? null },
      });
    },
  );
  const result = await client.send(action, scope, payload, expiresAt);
  const response = await db.rpc("omni_dispatch_v3_action", {
    _op: "record_response",
    _actor: actor,
    _job: jobId,
    _grant: grantId,
    _project: scope.projectId,
    _repo: scope.repo,
    _kind: scope.kind,
    _digest: scope.payloadDigest,
    _expires: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
    _action: result.status,
  });
  if (response.error || !response.data)
    throw new Error(
      "The signed v3 response was verified, but its local state could not be recorded.",
    );
  return result;
}

type CancellationSender = (
  actor: string,
  jobId: string,
  grantId: string,
  action: "cancel",
) => Promise<unknown>;

export async function cancelRevokedOmniV3Receipts(
  actor: string,
  send: CancellationSender = executeOmniV3Receipt,
) {
  if (process.env["JACKBOY_DISPATCH_V3_ENABLED"] !== "true") return;
  const db = untyped(supabaseAdmin);
  const pending = await db.rpc("omni_dispatch_v3_pending_cancellations", { _actor: actor });
  if (pending.error)
    throw new Error("Revoked v3 jobs could not be identified for signed cancellation.");
  const rows = z
    .array(z.object({ jobId: z.string().uuid(), grantId: z.string().uuid() }).strict())
    .parse(pending.data);
  for (const row of rows) {
    await send(actor, row.jobId, row.grantId, "cancel");
  }
}

async function databaseCallbackStore(nonce: string, input: Callback) {
  const db = untyped(supabaseAdmin);
  const response = await db.rpc("omni_dispatch_v3_callback_record", {
    _nonce: nonce,
    _owner: input.ownerId,
    _project: input.projectId,
    _job: input.jobId,
    _grant: input.grantId,
    _repo: input.repo,
    _digest: input.payloadDigest,
    _status: input.status,
    _result: input.result ?? null,
  });
  if (response.error) {
    if (response.error.message?.includes("Callback nonce replay"))
      throw new DispatchCallbackError(409, "callback_nonce_replayed");
    throw new Error("Callback transaction failed.");
  }
}

class DispatchCallbackError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

async function readCallbackBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing callback body.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 2000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_ENVELOPE_BYTES) {
        await reader.cancel();
        throw new Error("Callback body too large.");
      }
      chunks.push(value);
    }
    if (expired) throw new Error("Callback body timed out.");
    const raw = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      raw.set(chunk, offset);
      offset += chunk.length;
    }
    return { raw, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw) };
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export async function handleDispatchV3Callback(
  request: Request,
  settings = callbackSettings(),
  store: typeof databaseCallbackStore = databaseCallbackStore,
): Promise<Response> {
  const deny = (status: number, error: string) =>
    Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
  if (request.headers.get("x-omni-contract") !== CALLBACK_CONTRACT)
    return deny(410, "unsupported_callback_contract");
  if (!settings) return deny(503, "callback_disabled");
  const url = new URL(request.url);
  if (
    request.method !== "POST" ||
    url.protocol !== "https:" ||
    url.pathname !== CALLBACK_PATH ||
    url.search
  )
    return deny(400, "https_post_required");
  const client = request.headers.get("x-omni-client") || "";
  const timestamp = request.headers.get("x-omni-timestamp") || "";
  const nonce = request.headers.get("x-omni-nonce") || "";
  const signature = request.headers.get("x-omni-signature") || "";
  if (
    client !== settings.clientId ||
    !/^[0-9]{10}$/.test(timestamp) ||
    Math.abs(Date.now() - Number(timestamp) * 1000) > 60_000 ||
    !/^[a-f0-9]{32}$/.test(nonce)
  )
    return deny(401, "authentication_failed");
  let raw: Uint8Array;
  let text: string;
  try {
    ({ raw, text } = await readCallbackBody(request));
  } catch {
    return deny(400, "invalid_body");
  }
  const expected = createHmac("sha256", settings.secret)
    .update(
      `${CALLBACK_CONTRACT}\nPOST\n${CALLBACK_PATH}\n${client}\n${timestamp}\n${nonce}\n`,
      "utf8",
    )
    .update(raw)
    .digest("hex");
  if (!/^[a-f0-9]{64}$/.test(signature) || !safeEqual(signature, expected))
    return deny(401, "authentication_failed");
  let input: Callback;
  try {
    if (raw.byteLength > MAX_ENVELOPE_BYTES) throw new Error("Callback too large.");
    assertNoDuplicateKeys(text);
    const parsed: unknown = JSON.parse(text);
    assertValidUnicode(parsed);
    input = callbackSchema.parse(parsed);
    if (Buffer.byteLength(text, "utf8") !== raw.byteLength)
      throw new Error("Callback UTF-8 encoding mismatch.");
  } catch {
    return deny(400, "invalid_request");
  }
  try {
    await store(nonce, input);
  } catch (error) {
    if (error instanceof DispatchCallbackError) return deny(error.status, error.code);
    return deny(503, "callback_unavailable");
  }
  const body = JSON.stringify({
    contract: CALLBACK_CONTRACT,
    requestNonce: nonce,
    status: input.status,
  });
  const proof = await hmacHex(
    settings.secret,
    `${CALLBACK_CONTRACT}\nresponse\n${nonce}\n200\n${body}`,
  );
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Omni-Proof": proof,
    },
  });
}

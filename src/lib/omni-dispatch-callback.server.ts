import { z } from "zod";
import { hmacHex, safeEqual } from "./omni-link";
import { dispatchPayloadDigest } from "./omni-dispatch-digest";
import { wireKind } from "./omni-handoff-auth";
import { CALLBACK_V2, CALLBACK_V3, V3_CALLBACK_STATUSES, v3ResultSchema } from "./omni-dispatch-v3";

const PATH = "/api/public/omni/callback";
const scopeFields = {
  ownerId: z.string().uuid(),
  projectId: z.string().uuid(),
  grantId: z.string().uuid(),
  jobId: z.string().uuid(),
  repo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .max(200),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
};
const callbackSchema = z
  .object({
    contract: z.literal(CALLBACK_V2),
    ...scopeFields,
    status: z.enum(["quarantined", "cancelled"]),
  })
  .strict();
const callbackV3Schema = z
  .object({
    contract: z.literal(CALLBACK_V3),
    ...scopeFields,
    status: z.enum(V3_CALLBACK_STATUSES),
    result: v3ResultSchema.optional(),
  })
  .strict()
  .refine((c) => c.result === undefined || c.status === "completed" || c.status === "failed", {
    message: "A result is only allowed for completed or failed jobs.",
  });
type CallbackV2 = z.infer<typeof callbackSchema>;
type CallbackV3 = z.infer<typeof callbackV3Schema>;
export type Callback = CallbackV2 | CallbackV3;
type Store = (nonce: string, callback: Callback) => Promise<void>;
type Settings = { clientId: string; secret: string };
/** v3 carries up to 6 KB of output plus a 500-character summary; JSON escaping can grow it. */
const BODY_LIMIT = { [CALLBACK_V2]: 8192, [CALLBACK_V3]: 40960 } as const;

function config(): Settings | null {
  if (process.env["OMNI_DISPATCH_CALLBACK_ENABLED"] !== "true") return null;
  const clientId = process.env["OMNI_DISPATCH_CALLBACK_CLIENT_ID"] || "";
  const secret = process.env["OMNI_DISPATCH_CALLBACK_SECRET"] || "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientId) || secret.length < 32) return null;
  return { clientId, secret };
}

/**
 * v3 result states may arrive after the approval window closes. For these, the grant must exist,
 * match owner/project/job/repo/digest and belong to a job Jackboy itself submitted via v3 — but it
 * need not be unexpired, and the live link need not be fresh. Pre-run "quarantined" keeps the full check.
 */
export const isV3ResultCallback = (input: Callback) =>
  input.contract === CALLBACK_V3 && input.status !== "quarantined";

/** Grant + digest verification before anything is stored. */
async function databaseStore(nonce: string, input: Callback) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { untyped } = await import("./untyped-db");
  const db = untyped(supabaseAdmin);
  const grant = isV3ResultCallback(input)
    ? await db.rpc("omni_dispatch_v3_callback_scope", {
        _owner: input.ownerId,
        _job: input.jobId,
        _grant: input.grantId,
      })
    : await db.rpc("omni_dispatch_grant_action", {
        _op: "check",
        _actor: input.ownerId,
        _job: input.jobId,
        _grant: input.grantId,
      });
  if (grant.error) throw new Error("Callback authorization unavailable.");
  const row = z
    .object({
      // Live check answers `valid: true`; the v3 result-scope read answers `found: true`.
      ...(isV3ResultCallback(input) ? { found: z.literal(true) } : { valid: z.literal(true) }),
      id: z.string().uuid(),
      ownerId: z.string().uuid(),
      projectId: z.string().uuid(),
      jobId: z.string().uuid(),
      repo: z.string(),
      kind: z.enum(["code", "test"]),
      instructions: z.string(),
    })
    .parse(grant.data);
  const digest = await dispatchPayloadDigest({ ...row, kind: wireKind(row.kind), grantId: row.id });
  if (
    row.id !== input.grantId ||
    row.ownerId !== input.ownerId ||
    row.jobId !== input.jobId ||
    row.projectId !== input.projectId ||
    row.repo !== input.repo ||
    !safeEqual(digest, input.payloadDigest)
  )
    throw new Error("Callback scope mismatch.");
  if (input.contract === CALLBACK_V3) {
    const result = await db.rpc("omni_dispatch_v3_record", {
      _source: "callback",
      _nonce: nonce,
      _owner: input.ownerId,
      _project: input.projectId,
      _job: input.jobId,
      _grant: input.grantId,
      _repo: input.repo,
      _status: input.status,
      _result: input.result ?? null,
    });
    if (result.error || !result.data) throw new Error("Callback transaction failed.");
    return;
  }
  const result = await db.rpc("omni_dispatch_callback_record", {
    _nonce: nonce,
    _owner: input.ownerId,
    _project: input.projectId,
    _job: input.jobId,
    _grant: input.grantId,
    _repo: input.repo,
    _status: input.status,
  });
  if (result.error || !result.data) throw new Error("Callback transaction failed.");
}

async function readBody(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing body");
  let bytes = 0,
    expired = false;
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
      if (bytes > limit) {
        await reader.cancel();
        throw new Error("Body too large");
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

export async function handleDispatchCallback(
  request: Request,
  settings: Settings | null = config(),
  store: Store = databaseStore,
): Promise<Response> {
  const deny = (status: number, error: string) =>
    Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
  const header = request.headers.get("x-omni-contract");
  if (header !== CALLBACK_V2 && header !== CALLBACK_V3) return deny(410, "legacy_callback_disabled");
  const CONTRACT = header;
  if (!settings) return deny(503, "callback_disabled");
  const url = new URL(request.url);
  if (request.method !== "POST" || url.protocol !== "https:" || url.pathname !== PATH || url.search)
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
  let raw: string;
  try {
    raw = await readBody(request, BODY_LIMIT[CONTRACT]);
  } catch {
    return deny(400, "invalid_body");
  }
  const expected = await hmacHex(
    settings.secret,
    `${CONTRACT}\nPOST\n${PATH}\n${client}\n${timestamp}\n${nonce}\n${raw}`,
  );
  if (!/^[a-f0-9]{64}$/.test(signature) || !safeEqual(signature, expected))
    return deny(401, "authentication_failed");
  let input: Callback;
  try {
    const json: unknown = JSON.parse(raw);
    input = CONTRACT === CALLBACK_V3 ? callbackV3Schema.parse(json) : callbackSchema.parse(json);
  } catch {
    return deny(400, "invalid_request");
  }
  try {
    await store(nonce, input);
  } catch {
    return deny(503, "callback_unavailable");
  }
  const body = JSON.stringify({ contract: CONTRACT, requestNonce: nonce, status: input.status });
  const proof = await hmacHex(settings.secret, `${CONTRACT}\nresponse\n${nonce}\n200\n${body}`);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Omni-Proof": proof,
    },
  });
}

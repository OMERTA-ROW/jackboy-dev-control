import { z } from "zod";
import { hmacHex, safeEqual } from "./omni-link";
import { dispatchPayloadDigest } from "./omni-dispatch-digest";

const CONTRACT = "jackboy.dispatch-callback/v2";
const PATH = "/api/public/omni/callback";
const callbackSchema = z
  .object({
    contract: z.literal(CONTRACT),
    ownerId: z.string().uuid(),
    projectId: z.string().uuid(),
    grantId: z.string().uuid(),
    jobId: z.string().uuid(),
    repo: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
      .max(200),
    payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["quarantined", "cancelled"]),
  })
  .strict();
type Callback = z.infer<typeof callbackSchema>;
type Store = (nonce: string, callback: Callback) => Promise<void>;
type Settings = { clientId: string; secret: string };

function config(): Settings | null {
  if (process.env["OMNI_DISPATCH_CALLBACK_ENABLED"] !== "true") return null;
  const clientId = process.env["OMNI_DISPATCH_CALLBACK_CLIENT_ID"] || "";
  const secret = process.env["OMNI_DISPATCH_CALLBACK_SECRET"] || "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientId) || secret.length < 32) return null;
  return { clientId, secret };
}

async function databaseStore(nonce: string, input: Callback) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { untyped } = await import("./untyped-db");
  const db = untyped(supabaseAdmin);
  const grant = await db.rpc("omni_dispatch_grant_action", {
    _op: "check",
    _actor: input.ownerId,
    _job: input.jobId,
    _grant: input.grantId,
  });
  if (grant.error) throw new Error("Callback authorization unavailable.");
  const row = z
    .object({
      valid: z.literal(true),
      id: z.string().uuid(),
      ownerId: z.string().uuid(),
      projectId: z.string().uuid(),
      jobId: z.string().uuid(),
      repo: z.string(),
      kind: z.literal("test"),
      instructions: z.string(),
    })
    .parse(grant.data);
  const digest = await dispatchPayloadDigest({ ...row, grantId: row.id });
  if (
    row.projectId !== input.projectId ||
    row.repo !== input.repo ||
    !safeEqual(digest, input.payloadDigest)
  )
    throw new Error("Callback scope mismatch.");
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

async function readBody(request: Request) {
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
      if (bytes > 8192) {
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
  if (request.headers.get("x-omni-contract") !== CONTRACT)
    return deny(410, "legacy_callback_disabled");
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
    raw = await readBody(request);
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
    input = callbackSchema.parse(JSON.parse(raw));
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

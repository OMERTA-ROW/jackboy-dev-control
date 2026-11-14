// Signed permit actions on the existing omni.link/v2 endpoint. OMNI authenticates with its link
// session token (from the Step 9 handshake), the HMAC request signature and a single-use nonce.
// Jackboy answers with a nonce-bound proof, and active permits carry their own signature so OMNI
// workers can verify them independently. Any store failure fails closed (no permit).
import { hmacHex } from "./omni-link";
import { digest, LINK_CONTRACT, LINK_PATH, linkRequestUrl, verifyRequest } from "./omni-session";
import type { LinkConfig, StoreReply } from "./omni-session.server";
import {
  PERMIT_CONTRACT,
  PERMIT_RENEW_EVERY_SECONDS,
  SAFETY_CONTRACT,
  parsePermitInput,
  signPermit,
} from "./omni-permit";

export type PermitStore = (
  op: "request" | "release" | "safety",
  args: Record<string, unknown>,
) => Promise<StoreReply>;

export const databasePermitStore: PermitStore = async (op, args) => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // Installed on production as migration 0066_omni_execution_permits; any error still fails closed.
  const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
    name: string,
    a: Record<string, unknown>,
  ) => Promise<{ data: StoreReply | null; error: unknown }>;
  const { data, error } = await rpc("omni_execution_permit_action", { _op: op, _a: args });
  if (error || !data || typeof data.http !== "number") throw new Error("permit_store_unavailable");
  return data;
};

const OPS = { "permit.request": "request", "permit.release": "release", safety: "safety" } as const;

export async function handleOmniPermit(
  request: Request,
  raw: string,
  c: LinkConfig | null,
  store: PermitStore = databasePermitStore,
  env: Record<string, string | undefined> = process.env,
): Promise<Response> {
  const plain = (status: number, error: string) =>
    Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
  if (!c) return plain(503, "link_disabled");
  const url = linkRequestUrl(request, env);
  if (
    !url ||
    url.pathname !== LINK_PATH ||
    url.search ||
    request.method !== "POST" ||
    raw.length > 8192
  )
    return plain(400, "https_post_required");
  const token =
    request.headers.get("authorization")?.match(/^Bearer ([a-zA-Z0-9_-]{32,256})$/)?.[1] || "";
  // A bootstrap key is never a session: permits require the handshake's session token.
  if (
    !token ||
    token === c.bootstrap ||
    request.headers.get("x-omni-client") !== c.clientId ||
    !(await verifyRequest(c.secret, token, request.headers, raw))
  )
    return plain(401, "authentication_failed");
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return plain(400, "invalid_request");
  }
  const parsed = parsePermitInput(input, c.projectId);
  if (!parsed.ok) return plain(parsed.error === "invalid_request" ? 400 : 403, parsed.error);
  const nonce = request.headers.get("x-omni-nonce")!;
  const v = parsed.value;
  let out: StoreReply;
  try {
    out = await store(OPS[v.action], {
      clientId: c.clientId,
      projectId: c.projectId,
      ownerId: c.ownerId,
      approvalId: c.approvalId,
      approvalExpiresAt: c.approvalExpiresAt,
      tokenHash: await digest(token),
      nonce,
      ...(v.action === "safety" ? {} : { jobId: v.jobId }),
      ...(v.action === "permit.request"
        ? { kind: v.kind, digest: v.digest, estimateUsd: v.estimateUsd }
        : {}),
    });
  } catch {
    return plain(503, "permit_service_unavailable");
  }
  const payload: Record<string, unknown> = { contract: LINK_CONTRACT, requestNonce: nonce, ...out };
  const permit = out["permit"] as Record<string, unknown> | null | undefined;
  if (
    v.action === "permit.request" &&
    out.http === 200 &&
    permit &&
    permit["status"] === "active"
  ) {
    const fields = {
      permitId: String(permit["id"]),
      jobId: String(permit["jobId"]),
      kind: String(permit["kind"]),
      digest: String(permit["digest"]),
      clientId: c.clientId,
      projectId: c.projectId,
      approvalId: c.approvalId,
      expiresAt: String(permit["expiresAt"]),
    };
    payload["permit"] = {
      ...permit,
      contract: PERMIT_CONTRACT,
      clientId: c.clientId,
      projectId: c.projectId,
      approvalId: c.approvalId,
      renewEverySeconds: PERMIT_RENEW_EVERY_SECONDS,
      signature: await signPermit(c.secret, fields),
    };
  }
  if (v.action === "safety" && out["safety"] && typeof out["safety"] === "object")
    payload["safety"] = {
      contract: SAFETY_CONTRACT,
      ...(out["safety"] as Record<string, unknown>),
    };
  const body = JSON.stringify(payload);
  return new Response(body, {
    status: out.http,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Omni-Proof": await hmacHex(
        c.secret,
        `${LINK_CONTRACT}\nresponse\n${nonce}\n${out.http}\n${body}`,
      ),
    },
  });
}

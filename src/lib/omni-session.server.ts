import { hmacHex, safeEqual } from "./omni-link";
import { resolveApproval, type EffectiveApproval, type SavedApproval } from "./omni-link-approval";
import {
  digest,
  LINK_CONTRACT,
  LINK_PATH,
  linkRequestUrl,
  SCOPES,
  UUID,
  verifyRequest,
} from "./omni-session";
import { runProtocolSelfTest, protocolRunnerAvailable } from "./omni-session-runner.server";
import { callRemoteRunner, remoteRunnerConfig, RUNNER_TIMEOUT_MS } from "./omni-remote-runner";

export type LinkConfig = {
  clientId: string;
  projectId: string;
  ownerId: string;
  approvalId: string;
  approvalExpiresAt: string;
  bootstrap: string;
  secret: string;
};
export type StoreReply = {
  http: number;
  error?: string;
  expiresAt?: string;
  claimed?: boolean;
  job?: { id: string; status: string; [key: string]: unknown };
  [key: string]: unknown;
};
export type LinkStore = (op: string, args: Record<string, unknown>) => Promise<StoreReply>;
/** Reads the passkey-saved approval (service role only). Any error = "not readable" (fail closed). */
export async function loadEffectiveApproval(env: Record<string, string | undefined> = process.env): Promise<EffectiveApproval> {
  try {
    const db = (await import("./untyped-db")).untyped((await import("@/integrations/supabase/client.server")).supabaseAdmin);
    const { data, error } = await db.from("omni_link_approval").select("approval_id, expires_at, saved_at").eq("id", 1).maybeSingle();
    if (error) return resolveApproval({ ok: false }, env);
    return resolveApproval({ ok: true, row: (data as SavedApproval | null) ?? null }, env);
  } catch {
    return resolveApproval({ ok: false }, env);
  }
}
/** The link gate with the effective approval (passkey-saved record over legacy settings). */
export async function resolvedLinkConfig(): Promise<LinkConfig | null> {
  const a = await loadEffectiveApproval();
  return linkConfig({ approvalId: a.approvalId, approvalExpiresAt: a.expiresAt });
}
/** Sync gate. Callers must pass the effective approval from `loadEffectiveApproval`; the env
 * default exists only for tests and is never used by the live link route. */
export function linkConfig(
  approval: { approvalId: string; approvalExpiresAt: string } = {
    approvalId: process.env["OMNI_LINK_APPROVAL_ID"] || "",
    approvalExpiresAt: process.env["OMNI_LINK_APPROVAL_EXPIRES_AT"] || "",
  },
): LinkConfig | null {
  if (process.env["OMNI_LINK_ENABLED"] !== "true") return null;
  const c = {
    clientId: process.env["OMNI_LINK_CLIENT_ID"] || "",
    projectId: process.env["OMNI_LINK_PROJECT_ID"] || "",
    ownerId: process.env["OMNI_LINK_OWNER_ID"] || "",
    approvalId: approval.approvalId,
    approvalExpiresAt: approval.approvalExpiresAt,
    bootstrap: process.env["OMNI_LINK_BOOTSTRAP_KEY"] || "",
    secret: process.env["OMNI_LINK_HMAC_SECRET"] || "",
  };
  const expiry = Date.parse(c.approvalExpiresAt);
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/.test(c.clientId) ||
    ![c.projectId, c.ownerId, c.approvalId].every((x) => UUID.test(x)) ||
    !Number.isFinite(expiry) ||
    expiry <= Date.now() ||
    expiry > Date.now() + 86400_000 ||
    !/^[-_a-zA-Z0-9]{32,256}$/.test(c.bootstrap) ||
    c.secret.length < 32 ||
    c.bootstrap === c.secret
  )
    return null;
  return c;
}
export const databaseStore: LinkStore = async (op, args) => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // New RPC is explicitly typed here until generated Cloud database types are refreshed.
  const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: StoreReply | null; error: unknown }>;
  const { data, error } = await rpc("omni_link_action", { _op: op, _a: args });
  if (error || !data) throw new Error("link_store_unavailable");
  return data;
};
export async function boundedBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 2000);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) {
        await reader.cancel();
        throw new Error("body_limit");
      }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timeout);
    reader.releaseLock();
  }
  if (expired) throw new Error("body_timeout");
  const data = new Uint8Array(size);
  let pos = 0;
  for (const c of chunks) {
    data.set(c, pos);
    pos += c.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(data);
}
// Dependencies are injectable for real protocol/database integration tests.
export async function handleOmniLink(
  request: Request,
  c: LinkConfig | null = linkConfig(),
  store: LinkStore = databaseStore,
  runner?: (signal: AbortSignal) => Promise<boolean>,
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  // Local Node runner first; otherwise the stateless remote runner (live site keeps all checks/storage).
  const remote = protocolRunnerAvailable() ? null : remoteRunnerConfig(env);
  const runnerReady = protocolRunnerAvailable() || Boolean(remote) || Boolean(runner);
  const plain = (status: number, error: string) =>
    Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
  if (!c) return plain(503, "link_disabled");
  const url = linkRequestUrl(request, env);
  if (!url || url.pathname !== LINK_PATH || url.search || request.method !== "POST")
    return plain(400, "https_post_required");
  const context = {
    clientId: c.clientId,
    projectId: c.projectId,
    ownerId: c.ownerId,
    approvalId: c.approvalId,
    approvalExpiresAt: c.approvalExpiresAt,
  };
  const deny = async (status: number, reason: string) => {
    await store("reject", { ...context, reason });
    return plain(status, reason);
  };
  try {
    const raw = await boundedBody(request);
    const token =
      request.headers.get("authorization")?.match(/^Bearer ([a-zA-Z0-9_-]{32,256})$/)?.[1] || "";
    if (
      !token ||
      request.headers.get("x-omni-client") !== c.clientId ||
      !(await verifyRequest(c.secret, token, request.headers, raw))
    )
      return await deny(401, "authentication_failed");
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(raw);
    } catch {
      return await deny(400, "invalid_request");
    }
    if (
      !input ||
      Array.isArray(input) ||
      typeof input !== "object" ||
      input["projectId"] !== c.projectId
    )
      return await deny(403, "project_denied");
    const action = input["action"];
    if (
      !["handshake", "submit", "status", "run", "cancel"].includes(String(action)) ||
      Object.keys(input).some((k) => !["action", "projectId", "jobId", "kind"].includes(k))
    )
      return await deny(403, "action_denied");
    if (action === "submit" && input["kind"] !== "protocol.self-test")
      return await deny(403, "kind_denied");
    if (
      action !== "handshake" &&
      (typeof input["jobId"] !== "string" || !UUID.test(input["jobId"]))
    )
      return await deny(400, "job_id_required");
    if (
      action === "handshake" &&
      (!safeEqual(token, c.bootstrap) ||
        input["jobId"] !== undefined ||
        input["kind"] !== undefined)
    )
      return await deny(401, "authentication_failed");
    if (action !== "submit" && input["kind"] !== undefined)
      return await deny(400, "invalid_request");
    if (["submit", "run"].includes(String(action)) && !runnerReady)
      return await deny(503, "runner_unavailable");
    const nonce = request.headers.get("x-omni-nonce")!;
    const sessionToken =
      crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const args = {
      ...context,
      nonce,
      tokenHash: await digest(token),
      newTokenHash: await digest(sessionToken),
      jobId: input["jobId"],
      kind: input["kind"],
    };
    let out = await store(String(action), args);
    if (out.http >= 400) return await deny(out.http, out.error || "request_denied");
    let runnerError: string | undefined;
    if (action === "run" && out.claimed) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), remote && !runner ? RUNNER_TIMEOUT_MS + 1000 : 3500);
      let polling = false;
      const monitor = setInterval(() => {
        if (polling) return;
        polling = true;
        void store("probe", args)
          .then((s) => {
            if (s.job?.status !== "running") abort.abort();
          })
          .catch(() => abort.abort())
          .finally(() => {
            polling = false;
          });
      }, 100);
      let passed = false;
      try {
        if (runner) passed = await runner(abort.signal);
        else if (remote) {
          const r = await callRemoteRunner(remote, String(input["jobId"]), abort.signal, fetcher);
          passed = r.passed;
          runnerError = r.error;
        } else passed = await runProtocolSelfTest(abort.signal);
      } catch {
        passed = false;
      } finally {
        clearTimeout(timer);
        clearInterval(monitor);
      }
      out = await store("finish", { ...args, passed });
    }
    const payload = {
      contract: LINK_CONTRACT,
      requestNonce: nonce,
      ...out,
      ...(runnerError ? { runnerError } : {}),
      ...(action === "handshake"
        ? {
            sessionToken,
            capabilities: SCOPES,
            ready: runnerReady,
            execution: "fixed-protocol-self-test-only",
          }
        : {}),
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
  } catch {
    return plain(503, "link_unavailable");
  } // Never echo transport/database/process errors or credentials.
}

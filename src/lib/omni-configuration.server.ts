import { hmacHex, safeEqual } from "./omni-link";
import { LINK_CONTRACT, LINK_PATH, UUID, linkRequestUrl, verifyRequest } from "./omni-session";
import { boundedBody, handleOmniLink, resolvedLinkConfig } from "./omni-session.server";
import { callRemoteRunnerConfiguration, remoteRunnerConfig } from "./omni-remote-runner";

type Env = Record<string, string | undefined>;
type ProbeConfig = {
  clientId: string;
  projectId: string;
  ownerId: string;
  bootstrap: string;
  secret: string;
};
type Authorize = (config: ProbeConfig, nonce: string) => Promise<boolean>;

function probeConfig(env: Env): ProbeConfig | null {
  const c = {
    clientId: env["OMNI_LINK_CLIENT_ID"] || "",
    projectId: env["OMNI_LINK_PROJECT_ID"] || "",
    ownerId: env["OMNI_LINK_OWNER_ID"] || "",
    bootstrap: env["OMNI_LINK_BOOTSTRAP_KEY"] || "",
    secret: env["OMNI_LINK_HMAC_SECRET"] || "",
  };
  return /^[a-zA-Z0-9_-]{1,64}$/.test(c.clientId) &&
    UUID.test(c.projectId) &&
    UUID.test(c.ownerId) &&
    /^[-_a-zA-Z0-9]{32,256}$/.test(c.bootstrap) &&
    c.secret.length >= 32 &&
    c.bootstrap !== c.secret
    ? c
    : null;
}

const authorize: Authorize = async (c, nonce) => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // Function comes from migration 0064_omni_configuration_probe, which is not yet
  // installed in the live database, so generated types do not list it. Until the
  // owner approves installing it, this call errors and the probe fails closed.
  const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
    fn: "omni_link_configuration_authorize",
    args: { _client_id: string; _project_id: string; _owner_id: string; _nonce: string },
  ) => Promise<{ data: unknown; error: unknown }>;
  const { data, error } = await rpc("omni_link_configuration_authorize", {
    _client_id: c.clientId,
    _project_id: c.projectId,
    _owner_id: c.ownerId,
    _nonce: nonce,
  });
  if (error) throw new Error("Configuration check authorization could not be recorded.");
  return data === true;
};

/** Bootstrap-authenticated metadata only: no sessions, jobs, approval grants or execution. */
export async function handleOmniConfiguration(
  request: Request,
  raw: string,
  env: Env = process.env,
  allow: Authorize = authorize,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const plain = (status: number, error: string) =>
    Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
  const c = probeConfig(env);
  if (!c) return plain(503, "configuration_check_unavailable");
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
  if (
    !safeEqual(token, c.bootstrap) ||
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
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== "action,projectId" ||
    !("action" in input) ||
    input.action !== "configuration" ||
    !("projectId" in input) ||
    input.projectId !== c.projectId
  )
    return plain(403, "project_or_action_denied");
  const nonce = request.headers.get("x-omni-nonce")!;
  try {
    if (!(await allow(c, nonce))) return plain(403, "configuration_scope_denied");
    const remote = remoteRunnerConfig(env);
    const result = remote
      ? await callRemoteRunnerConfiguration(remote, AbortSignal.timeout(5000), fetcher)
      : { error: "runner_configuration_unavailable" };
    const body = JSON.stringify({
      contract: LINK_CONTRACT,
      requestNonce: nonce,
      projectId: c.projectId,
      execution: "none",
      configuration:
        "configuration" in result
          ? {
              ...result.configuration,
              runnerOrigin: new URL(remote!.url).origin,
            }
          : null,
    });
    return new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Omni-Proof": await hmacHex(
          c.secret,
          `${LINK_CONTRACT}\nresponse\n${nonce}\n200\n${body}`,
        ),
      },
    });
  } catch {
    return plain(503, "configuration_check_unavailable");
  }
}

export async function handleOmniLinkRequest(request: Request): Promise<Response> {
  let raw: string;
  let input: unknown;
  try {
    raw = await boundedBody(request);
  } catch {
    return Response.json(
      { error: "invalid_request" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    input = JSON.parse(raw);
  } catch {
    input = null;
  }
  if (input && typeof input === "object" && "action" in input && input.action === "configuration")
    return handleOmniConfiguration(request, raw);
  return handleOmniLink(
    new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: raw,
    }),
    await resolvedLinkConfig(),
  );
}

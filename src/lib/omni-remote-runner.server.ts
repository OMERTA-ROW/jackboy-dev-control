// Runner-only mode (Railway): runs the fixed protocol self-test for the live site. No database,
// no OMNI link secrets, no caller code. Every other page on a runner-mode host is refused.
import { hmacHex } from "./omni-link";
import {
  nonceCache,
  responseMessage,
  runnerModeDecision,
  verifyRunnerRequest,
  validRunnerSecret,
  RUNNER_CONFIGURATION_KIND,
} from "./omni-remote-runner";
import { protocolRunnerAvailable, runProtocolSelfTest } from "./omni-session-runner.server";

type Env = Record<string, string | undefined>;
const claim = nonceCache();

export function runnerModeOn(env: Env = process.env, hostname?: string): boolean {
  return runnerModeDecision(env, hostname).on;
}

export async function handleRunnerRequest(
  request: Request,
  env: Env = process.env,
  runner: (s: AbortSignal) => Promise<boolean> = runProtocolSelfTest,
  available: () => boolean = protocolRunnerAvailable,
  claimNonce = claim,
): Promise<Response> {
  const plain = (status: number, error: string) =>
    Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
  const secret = env["OMNI_LINK_REMOTE_RUNNER_SECRET"];
  if (!runnerModeOn(env, new URL(request.url).hostname) || !validRunnerSecret(secret))
    return plain(404, "not_found");
  if (request.method !== "POST") {
    const response = plain(405, "post_required");
    response.headers.set("Allow", "POST");
    return response;
  }
  if (new URL(request.url).search) return plain(400, "post_required");
  const len = Number(request.headers.get("content-length") || "0");
  if (len > 1024) return plain(413, "body_limit");
  let body: string;
  try {
    body = await request.text();
  } catch {
    return plain(400, "invalid_request");
  }
  if (body.length > 1024) return plain(413, "body_limit");
  const v = await verifyRunnerRequest(secret, request.headers, body, claimNonce);
  if ("error" in v) return plain(v.error === "invalid_request" ? 400 : 401, v.error);
  const runtimeAvailable = available();
  if (v.kind === RUNNER_CONFIGURATION_KIND) {
    const out = JSON.stringify({
      jobId: v.jobId,
      nonce: v.nonce,
      kind: v.kind,
      execution: "none",
      configuration: {
        runnerMode: true,
        nodeRunnerEnabled: env["OMNI_LINK_NODE_RUNNER_ENABLED"] === "true",
        remoteRunnerSecretConfigured: true,
        runtimeAvailable,
      },
    });
    return new Response(out, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Runner-Proof": await hmacHex(secret, responseMessage(v.nonce, out)),
      },
    });
  }
  if (!runtimeAvailable) return plain(503, "runner_unavailable");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 3500);
  let passed = false;
  try {
    passed = await runner(abort.signal);
  } catch {
    passed = false;
  } finally {
    clearTimeout(timer);
  }
  const out = JSON.stringify({ jobId: v.jobId, nonce: v.nonce, passed });
  return new Response(out, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Runner-Proof": await hmacHex(secret, responseMessage(v.nonce, out)),
    },
  });
}

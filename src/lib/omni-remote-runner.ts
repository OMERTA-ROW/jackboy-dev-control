// Stateless remote runner for the fixed OMNI protocol self-test. Runtime-neutral (WebCrypto only).
// The live site keeps every OMNI check and all storage; the runner only runs the fixed test and
// signs a pass/fail bound to the job ID and a one-time nonce. No caller code, data or arguments.
import { hmacHex, safeEqual } from "./omni-link";

export const RUNNER_CONTRACT = "omni.runner/v1";
export const RUNNER_PATH = "/api/public/omni/runner";
export const RUNNER_KIND = "protocol.self-test";
export const RUNNER_SKEW_MS = 60_000;
export const RUNNER_NONCE_TTL_MS = 10 * 60_000;
export const RUNNER_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;

type Env = Record<string, string | undefined>;
export type RemoteRunnerConfig = { url: string; secret: string };

export function validRunnerSecret(s: string | undefined): s is string {
  return typeof s === "string" && s.length >= 32 && s.length <= 512;
}

// Runner-only mode is a Railway setting. A host that is clearly the Jackboy dashboard (a Lovable
// address, or one holding site-only settings such as the database key or the caller-side runner
// address) ignores it, so a misplaced OMNI_LINK_RUNNER_MODE can never blank the dashboard.
export type RunnerModeDecision = { on: boolean; ignored?: "lovable_host" | "site_settings" };
const DASHBOARD_HOST = /(^|\.)(lovable\.app|lovableproject\.com|lovable\.dev)$/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i;
const SITE_ONLY_SETTINGS = ["SUPABASE_SERVICE_ROLE_KEY", "OMNI_LINK_REMOTE_RUNNER_URL"] as const;

export function runnerModeDecision(env: Env, hostname?: string): RunnerModeDecision {
  if (env["OMNI_LINK_RUNNER_MODE"] !== "true") return { on: false };
  const host = (hostname ?? "").trim();
  if (host && (DASHBOARD_HOST.test(host) || LOCAL_HOST.test(host))) return { on: false, ignored: "lovable_host" };
  if (env["OMNI_LINK_REMOTE_RUNNER_ENABLED"] === "true" || SITE_ONLY_SETTINGS.some((k) => !!env[k]))
    return { on: false, ignored: "site_settings" };
  return { on: true };
}

/** The switch must be exactly lowercase `true` (the gate never loosens). A value that only
 * differs by capitals, spaces or quotes is named as such so it is not mistaken for "disabled". */
export const ENABLED_NOT_EXACT =
  "OMNI_LINK_REMOTE_RUNNER_ENABLED is set but is not exactly lowercase true (check capital letters, spaces or quotes); the runner stays off until it is exactly true";
function enabledProblem(v: string | undefined): string | null {
  if (v === "true") return null;
  const loose = (v ?? "").trim().replace(/^["']|["']$/g, "").trim().toLowerCase();
  return loose === "true" ? ENABLED_NOT_EXACT : "OMNI_LINK_REMOTE_RUNNER_ENABLED is not exactly true";
}

export function remoteRunnerDiagnostic(env: Env): string {
  const enabled = enabledProblem(env["OMNI_LINK_REMOTE_RUNNER_ENABLED"]);
  if (enabled === ENABLED_NOT_EXACT) return `${ENABLED_NOT_EXACT}.`;
  if (enabled) return "Remote self-test runner is disabled; this readiness check does not enable it.";
  if (!env["OMNI_LINK_REMOTE_RUNNER_URL"])
    return "OMNI_LINK_REMOTE_RUNNER_URL is missing.";
  if (!runnerOrigin(env["OMNI_LINK_REMOTE_RUNNER_URL"])) {
    const v = env["OMNI_LINK_REMOTE_RUNNER_URL"].trim();
    let u: URL;
    try {
      u = new URL(BARE_HOST.test(v) ? `https://${v}` : v);
    } catch {
      return "OMNI_LINK_REMOTE_RUNNER_URL is not a valid URL; use the runner's https address (for example https://name.up.railway.app).";
    }
    if (u.protocol !== "https:") return "OMNI_LINK_REMOTE_RUNNER_URL must use HTTPS.";
    if (u.username || u.password || u.search || u.hash)
      return "OMNI_LINK_REMOTE_RUNNER_URL must not contain credentials, a query, or a fragment.";
    return "OMNI_LINK_REMOTE_RUNNER_URL must be a bare origin; Jackboy appends /api/public/omni/runner, so remove any configured path to avoid a duplicated endpoint.";
  }
  if (!validRunnerSecret(env["OMNI_LINK_REMOTE_RUNNER_SECRET"]))
    return "OMNI_LINK_REMOTE_RUNNER_SECRET must be configured as a managed secret.";
  return "Remote runner origin is configured; this read-only check does not test live reachability.";
}

/** Live-site side: configured only when enabled, an exact https origin and a strong secret exist. */
export function remoteRunnerConfig(env: Env): RemoteRunnerConfig | null {
  if (env["OMNI_LINK_REMOTE_RUNNER_ENABLED"] !== "true") return null;
  const secret = env["OMNI_LINK_REMOTE_RUNNER_SECRET"];
  if (!validRunnerSecret(secret)) return null;
  const origin = runnerOrigin(env["OMNI_LINK_REMOTE_RUNNER_URL"]);
  return origin ? { url: `${origin}${RUNNER_PATH}`, secret } : null;
}

/** Bare host names (Railway shows "x.up.railway.app") are read as https://; plain http, paths, queries and credentials are refused. */
const BARE_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?$/i;
export function runnerOrigin(raw: string | undefined): string | null {
  const v = (raw || "").trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(BARE_HOST.test(v) ? `https://${v}` : v);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== ""))
    return null;
  return u.origin;
}

/** Names which runner setting blocks the remote runner, without ever including a value. */
export function runnerConfigProblem(env: Env): string | null {
  const enabled = enabledProblem(env["OMNI_LINK_REMOTE_RUNNER_ENABLED"]);
  if (enabled) return enabled;
  if (!validRunnerSecret(env["OMNI_LINK_REMOTE_RUNNER_SECRET"])) return "OMNI_LINK_REMOTE_RUNNER_SECRET is missing or shorter than 32 characters";
  if (!runnerOrigin(env["OMNI_LINK_REMOTE_RUNNER_URL"]))
    return "OMNI_LINK_REMOTE_RUNNER_URL must be the runner's https address with no path (for example https://name.up.railway.app)";
  return null;
}

export const requestMessage = (ts: string, nonce: string, body: string) =>
  `${RUNNER_CONTRACT}\nrequest\n${ts}\n${nonce}\n${body}`;
export const responseMessage = (nonce: string, body: string) =>
  `${RUNNER_CONTRACT}\nresponse\n${nonce}\n${body}`;

export type RemoteRunResult = { passed: boolean; error?: "runner_unreachable" | "runner_proof_invalid" };

/** Calls the runner once. Any transport, timeout or proof problem is a failure, never a pass. */
export async function callRemoteRunner(
  cfg: RemoteRunnerConfig,
  jobId: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<RemoteRunResult> {
  const nonce = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const ts = String(now);
  const body = JSON.stringify({ kind: RUNNER_KIND, jobId });
  const timeout = AbortSignal.timeout(RUNNER_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetcher(cfg.url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "jackboy-omni-link",
        "X-Runner-Timestamp": ts,
        "X-Runner-Nonce": nonce,
        "X-Runner-Signature": await hmacHex(cfg.secret, requestMessage(ts, nonce, body)),
      },
      body,
      signal: AbortSignal.any([signal, timeout]),
    });
  } catch {
    return { passed: false, error: "runner_unreachable" };
  }
  if (res.status !== 200) return { passed: false, error: "runner_unreachable" };
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { passed: false, error: "runner_unreachable" };
  }
  if (text.length > 1024) return { passed: false, error: "runner_proof_invalid" };
  const proof = res.headers.get("x-runner-proof") || "";
  if (!safeEqual(proof, await hmacHex(cfg.secret, responseMessage(nonce, text))))
    return { passed: false, error: "runner_proof_invalid" };
  try {
    const out = JSON.parse(text) as Record<string, unknown>;
    if (out["jobId"] !== jobId || out["nonce"] !== nonce || typeof out["passed"] !== "boolean")
      return { passed: false, error: "runner_proof_invalid" };
    return { passed: out["passed"] === true };
  } catch {
    return { passed: false, error: "runner_proof_invalid" };
  }
}

/** Runner side: in-memory one-time nonce memory (stateless otherwise). */
export function nonceCache(ttl = RUNNER_NONCE_TTL_MS) {
  const seen = new Map<string, number>();
  return (nonce: string, now = Date.now()) => {
    for (const [k, t] of seen) if (t <= now) seen.delete(k);
    if (seen.has(nonce)) return false;
    if (seen.size >= 10_000) return false;
    seen.set(nonce, now + ttl);
    return true;
  };
}

/** Runner side: verifies a request and returns the job ID, or a fixed refusal reason. */
export async function verifyRunnerRequest(
  secret: string,
  headers: Headers,
  body: string,
  claimNonce: (n: string, now?: number) => boolean,
  now = Date.now(),
): Promise<{ jobId: string; nonce: string } | { error: string }> {
  const ts = headers.get("x-runner-timestamp") || "";
  const nonce = headers.get("x-runner-nonce") || "";
  const sig = headers.get("x-runner-signature") || "";
  if (!/^\d{10,16}$/.test(ts) || !NONCE.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return { error: "authentication_failed" };
  if (Math.abs(now - Number(ts)) > RUNNER_SKEW_MS) return { error: "stale_request" };
  if (!safeEqual(sig, await hmacHex(secret, requestMessage(ts, nonce, body)))) return { error: "authentication_failed" };
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(body);
  } catch {
    return { error: "invalid_request" };
  }
  if (
    !input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== "jobId,kind" ||
    input["kind"] !== RUNNER_KIND ||
    typeof input["jobId"] !== "string" || !UUID.test(input["jobId"])
  )
    return { error: "invalid_request" };
  if (!claimNonce(nonce, now)) return { error: "replayed_request" };
  return { jobId: input["jobId"], nonce };
}

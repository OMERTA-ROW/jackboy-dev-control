// Pure rules for the Jackboy ⇄ OMNI link (contracts, signing, retries). Runtime-neutral: WebCrypto only.
export const HANDSHAKE_CONTRACT = "omni.handshake/v1";
export const JOB_CONTRACT = "omni.job/v1";
export const RESULT_CONTRACT = "omni.job-result/v1";
export const MAX_DISPATCH_ATTEMPTS = 8;
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
export const OMNI_VERIFICATION_MAX_AGE_MS = 5 * 60_000;
export const DEFAULT_CALLBACK_URL = "https://jackboy-dev-control.lovable.app/api/public/omni/callback";

const te = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, te.encode(message)));
}

export async function omniEndpointFingerprint(endpoint: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", te.encode(endpoint)));
}

/** Bind freshness to endpoint and credentials without storing the credentials in the fingerprint. */
export async function omniConfigurationFingerprint(
  endpoint: string,
  apiKey: string,
  callbackSecret: string,
  callbackUrl: string,
): Promise<string> {
  const apiKeyHash = hex(await crypto.subtle.digest("SHA-256", te.encode(apiKey)));
  return hmacHex(callbackSecret, `omni.connection/v1\n${endpoint}\n${apiKeyHash}\n${callbackUrl}`);
}

export function safeOmniPullRequestUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.origin === "https://github.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function safeOmniCallbackOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

/** Signed string for callbacks: `${timestamp}.${nonce}.${rawBody}` (same as OMNI's Go signer). */
export const signedString = (ts: string, nonce: string, body: string) => `${ts}.${nonce}.${body}`;

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Returns null when the callback signature is valid and fresh, otherwise the refusal reason. */
export async function verifyCallback(secret: string, h: { signature: string | null; timestamp: string | null; nonce: string | null }, body: string, now = Date.now()): Promise<string | null> {
  if (!h.signature || !h.timestamp || !h.nonce) return "missing signature headers";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(h.nonce)) return "bad nonce";
  const ts = Number(h.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts * 1000) > MAX_CLOCK_SKEW_MS) return "stale or invalid timestamp";
  const expected = `sha256=${await hmacHex(secret, signedString(h.timestamp, h.nonce, body))}`;
  return safeEqual(expected, h.signature) ? null : "signature mismatch";
}

export function dispatchBackoffMs(attempts: number): number {
  return Math.min(6 * 3600_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

export function isOmniVerificationFresh(
  row: { verified?: boolean; verified_at?: string | null; config_hash?: string | null } | null,
  expectedConfigHash: string,
  now = Date.now(),
) {
  if (!row?.verified || !row.verified_at || row.config_hash !== expectedConfigHash) return false;
  const verifiedAt = Date.parse(row.verified_at);
  return (
    Number.isFinite(verifiedAt) &&
    verifiedAt <= now + 30_000 &&
    now - verifiedAt <= OMNI_VERIFICATION_MAX_AGE_MS
  );
}

/** Remote handshake errors are untrusted; only expose known-safe, useful diagnostics. */
export function safeOmniDiagnostic(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const message = value.trim();
  if (message === "OMNI verification expired; check the link again." ||
      message === "OMNI configuration changed since it was verified.") return message;
  const missing = /^Missing secrets: ((?:OMNI_API_URL|OMNI_API_KEY|OMNI_CALLBACK_SECRET)(?:, (?:OMNI_API_URL|OMNI_API_KEY|OMNI_CALLBACK_SECRET))*)$/.exec(message);
  if (missing?.[1]) return `Missing secrets: ${[...new Set(missing[1].split(", "))].join(", ")}`;
  const http = /^OMNI answered HTTP (\d{3})(?::.*)?$/.exec(message);
  if (http) return `OMNI answered HTTP ${http[1]}. Response details withheld.`;
  if (message === "OMNI proof did not match OMNI_CALLBACK_SECRET") return "OMNI did not prove the configured callback secret.";
  if (message === "OMNI returned invalid handshake JSON") return message;
  if (
    message === "OMNI did not answer with the handshake contract" ||
    message === "OMNI handshake has no version" ||
    message === "OMNI handshake has no capability list" ||
    message === "OMNI handshake has no proof"
  ) return message;
  return "OMNI reported an error; response details withheld.";
}

export type Handshake = { version: string; capabilities: string[]; proof: string };
export function parseHandshake(x: unknown): Handshake | string {
  const o = x as Record<string, unknown> | null;
  if (!o || o["contract"] !== HANDSHAKE_CONTRACT) return "OMNI did not answer with the handshake contract";
  if (typeof o["version"] !== "string" || !o["version"]) return "OMNI handshake has no version";
  if (!Array.isArray(o["capabilities"]) || !o["capabilities"].every((c) => typeof c === "string")) return "OMNI handshake has no capability list";
  if (typeof o["proof"] !== "string") return "OMNI handshake has no proof";
  return { version: o["version"].slice(0, 60), capabilities: (o["capabilities"] as string[]).slice(0, 30).map((c) => c.slice(0, 60)), proof: o["proof"] };
}

export type JobResult = { jobId: string; status: "running" | "completed" | "failed"; summary: string; prUrl: string | null; tests: { passed: boolean; output: string } | null; diffStat: string | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseResult(x: unknown): JobResult | string {
  const o = x as Record<string, unknown> | null;
  if (!o || o["contract"] !== RESULT_CONTRACT) return "wrong contract";
  if (typeof o["jobId"] !== "string" || !UUID.test(o["jobId"])) return "bad jobId";
  const status = o["status"];
  if (status !== "running" && status !== "completed" && status !== "failed") return "bad status";
  const pr = typeof o["prUrl"] === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(o["prUrl"]) ? o["prUrl"] : null;
  const t = o["tests"] as Record<string, unknown> | null | undefined;
  const tests = t && typeof t["passed"] === "boolean" ? { passed: t["passed"], output: String(t["output"] ?? "").slice(0, 8000) } : null;
  return { jobId: o["jobId"], status, summary: String(o["summary"] ?? "").slice(0, 2000), prUrl: pr, tests, diffStat: typeof o["diffStat"] === "string" ? o["diffStat"].slice(0, 4000) : null };
}

/** Allowed job status moves from an OMNI callback. Finished jobs never reopen. */
export function nextStatus(current: string, reported: JobResult["status"]): string | null {
  if (current === "sent" || current === "running") return reported;
  return null;
}

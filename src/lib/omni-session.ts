// Versioned reverse link. Reuses the existing OMNI HMAC implementation.
import { hmacHex, safeEqual } from "./omni-link";
export const LINK_PATH = "/api/public/omni/link";
export const LINK_CONTRACT = "omni.link/v2";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SCOPES = ["protocol.self-test", "jobs.read", "jobs.cancel"];
// Effective request URL for the link. Direct https: requests pass unchanged. Plain http: is
// accepted only behind an explicitly trusted HTTPS edge (Railway): OMNI_LINK_BEHIND_HTTPS_PROXY
// must be "true", JACKBOY_LINK_ORIGIN a clean https origin, the proxy-appended (last)
// X-Forwarded-Proto exactly "https" and the forwarded/Host host equal to the origin host.
export function linkRequestUrl(
  request: Request,
  env: Record<string, string | undefined>,
): URL | null {
  const url = new URL(request.url);
  if (url.protocol === "https:") return url;
  if (url.protocol !== "http:" || env["OMNI_LINK_BEHIND_HTTPS_PROXY"] !== "true") return null;
  let origin: URL;
  try {
    origin = new URL(env["JACKBOY_LINK_ORIGIN"] || "");
  } catch {
    return null;
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    env["JACKBOY_LINK_ORIGIN"]!.replace(/\/$/, "") !== origin.origin
  )
    return null;
  const last = (v: string | null) => (v ?? "").split(",").pop()!.trim();
  if (last(request.headers.get("x-forwarded-proto")) !== "https") return null;
  const host = (
    last(request.headers.get("x-forwarded-host")) ||
    request.headers.get("host") ||
    url.host
  ).toLowerCase();
  if (host !== origin.host) return null;
  return new URL(origin.origin + url.pathname + url.search);
}
export async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export function requestMessage(ts: string, nonce: string, tokenHash: string, body: string) {
  return `${LINK_CONTRACT}\nPOST\n${LINK_PATH}\n${ts}\n${nonce}\n${tokenHash}\n${body}`;
}
export type RequestCheck =
  | { ok: true; skewSeconds: number }
  | {
      ok: false;
      check: "timestamp_format" | "clock_skew" | "nonce_format" | "signature";
      skewSeconds: number | null;
    };
/** Same rules as `verifyRequest`, but names the failing check and the clock skew (seconds,
 *  Jackboy minus OMNI). Returns no secret-derived data. */
export async function diagnoseRequest(
  secret: string,
  token: string,
  headers: Headers,
  body: string,
  now = Date.now(),
): Promise<RequestCheck> {
  const ts = headers.get("x-omni-timestamp") || "",
    nonce = headers.get("x-omni-nonce") || "";
  if (!/^\d{10}$/.test(ts)) return { ok: false, check: "timestamp_format", skewSeconds: null };
  const skewMs = now - Number(ts) * 1000;
  const skewSeconds = Math.round(skewMs / 1000);
  if (Math.abs(skewMs) > 60_000) return { ok: false, check: "clock_skew", skewSeconds };
  if (!/^[a-f0-9]{32}$/.test(nonce)) return { ok: false, check: "nonce_format", skewSeconds };
  const match = safeEqual(
    headers.get("x-omni-signature") || "",
    await hmacHex(secret, requestMessage(ts, nonce, await digest(token), body)),
  );
  return match ? { ok: true, skewSeconds } : { ok: false, check: "signature", skewSeconds };
}
export async function verifyRequest(
  secret: string,
  token: string,
  headers: Headers,
  body: string,
  now = Date.now(),
) {
  return (await diagnoseRequest(secret, token, headers, body, now)).ok;
}

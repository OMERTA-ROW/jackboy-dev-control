// Versioned reverse link. Reuses the existing OMNI HMAC implementation.
import { hmacHex, safeEqual } from "./omni-link";
export const LINK_PATH = "/api/public/omni/link";
export const LINK_CONTRACT = "omni.link/v2";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SCOPES = ["protocol.self-test", "jobs.read", "jobs.cancel"];
export async function digest(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export function requestMessage(ts: string, nonce: string, tokenHash: string, body: string) {
  return `${LINK_CONTRACT}\nPOST\n${LINK_PATH}\n${ts}\n${nonce}\n${tokenHash}\n${body}`;
}
export async function verifyRequest(
  secret: string,
  token: string,
  headers: Headers,
  body: string,
  now = Date.now(),
) {
  const ts = headers.get("x-omni-timestamp") || "",
    nonce = headers.get("x-omni-nonce") || "";
  if (
    !/^\d{10}$/.test(ts) ||
    Math.abs(now - Number(ts) * 1000) > 60_000 ||
    !/^[a-f0-9]{32}$/.test(nonce)
  )
    return false;
  return safeEqual(
    headers.get("x-omni-signature") || "",
    await hmacHex(secret, requestMessage(ts, nonce, await digest(token), body)),
  );
}

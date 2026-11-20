// Shared by the browser voice client and the /api/live relay.
// Browsers can't set headers on a WebSocket, so the owner's session token travels as a
// Sec-WebSocket-Protocol entry. The server verifies it BEFORE accepting the socket and only
// ever echoes LIVE_PROTOCOL back, never the token.
export const LIVE_PROTOCOL = "jackboy.live.v1";
export const LIVE_AUTH_PREFIX = "jackboy.auth.";
const TOKEN = /^[A-Za-z0-9._-]{20,8000}$/;

export function liveProtocols(token: string): string[] {
  return [LIVE_PROTOCOL, `${LIVE_AUTH_PREFIX}${token}`];
}

/** Returns the session token offered in the upgrade request, or null when absent or malformed. */
export function liveTokenFromProtocols(header: string | null): string | null {
  if (!header || header.length > 9000) return null;
  const items = header.split(",").map((s) => s.trim()).filter(Boolean);
  if (!items.includes(LIVE_PROTOCOL)) return null;
  const auth = items.filter((s) => s.startsWith(LIVE_AUTH_PREFIX));
  if (auth.length !== 1) return null;
  const token = auth[0]!.slice(LIVE_AUTH_PREFIX.length);
  return TOKEN.test(token) ? token : null;
}

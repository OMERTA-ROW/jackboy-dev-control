// Client-safe helpers for single-use invitation tokens. Only the SHA-256 hash is stored.

export const INVITE_TTL_DAYS = 7;

export function newInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function isWellFormedToken(token: unknown): token is string {
  return typeof token === "string" && /^[0-9a-f]{64}$/.test(token);
}

export type InviteRow = { status: string; expires_at: string; used_at: string | null };

/** A token is redeemable only once, only while pending, and only before it expires. */
export function inviteRedeemable(row: InviteRow | null, now = new Date()): { ok: true } | { ok: false; reason: string } {
  if (!row) return { ok: false, reason: "This invitation link is invalid." };
  if (row.used_at || row.status === "accepted") return { ok: false, reason: "This invitation has already been used." };
  if (row.status === "revoked") return { ok: false, reason: "This invitation was revoked." };
  if (new Date(row.expires_at) <= now) return { ok: false, reason: "This invitation has expired." };
  return { ok: true };
}

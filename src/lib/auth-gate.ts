// Pure rules for the private-page gate (src/routes/_authenticated/route.tsx).
// A dropped connection must never look like "signed out" or "no access": only a definite
// answer from the auth service / role check may redirect. Server functions still re-check.

export type GateUserResult = {
  user: { id: string } | null;
  error: { name?: string; status?: number; message?: string } | null;
};
export type GateRoleResult = { role: unknown; error: unknown };
export type GateDecision =
  | { kind: "signin" }
  | { kind: "onboarding" }
  | { kind: "retry"; reason: string }
  | { kind: "ok"; role: "owner" | "admin" | "member" };

export const GATE_CONNECTION_MESSAGE =
  "Connection problem: Jackboy couldn't confirm your sign-in just now. You are still signed in — check your connection and press Try again.";

/** True when the auth error means "could not reach / service failed", not "no valid session". */
export function isTransientAuthError(e: GateUserResult["error"]): boolean {
  if (!e) return false;
  if (e.name === "AuthRetryableFetchError") return true;
  if (e.name === "AuthSessionMissingError") return false;
  const s = e.status;
  if (s === undefined || s === 0) return /fetch|network|timeout|load failed|offline/i.test(e.message ?? "") || s === 0;
  return s === 408 || s === 429 || s >= 500;
}

export function decideUser(r: GateUserResult): GateDecision | null {
  if (r.user) return null; // continue to the role check
  if (isTransientAuthError(r.error)) return { kind: "retry", reason: "auth_unreachable" };
  return { kind: "signin" };
}

/** Any role-check error is a retry, never "no access": only a clean empty answer means no role. */
export function decideRole(r: GateRoleResult): GateDecision {
  if (r.error) return { kind: "retry", reason: "role_unreachable" };
  if (r.role === "owner" || r.role === "admin" || r.role === "member") return { kind: "ok", role: r.role };
  return { kind: "onboarding" };
}

/** Collapses the burst of identical checks fired by link preloads into one per token. */
export const GATE_CACHE_MS = 30_000;
export function gateCacheValid(
  cache: { token: string; at: number } | null,
  token: string | null,
  now: number,
): boolean {
  return Boolean(cache && token && cache.token === token && now - cache.at < GATE_CACHE_MS && now >= cache.at);
}

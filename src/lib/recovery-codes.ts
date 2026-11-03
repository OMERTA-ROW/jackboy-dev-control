// Pure rules for one-time MFA recovery codes. Only salted SHA-256 hashes are stored.
export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_ATTEMPT_LIMIT = 5; // per user per window
export const RECOVERY_WINDOW_MIN = 15;
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O/1/I/L/U

export function newRecoveryCode(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const s = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
export function newRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: n }, newRecoveryCode);
}
export function normalizeRecoveryCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length !== 10 || [...s].some((c) => !ALPHABET.includes(c))) return null;
  return s;
}
/** Salted by user id so identical codes across users never share a hash. */
export async function hashRecoveryCode(userId: string, code: string): Promise<string> {
  const n = normalizeRecoveryCode(code);
  if (!n) throw new Error("Invalid recovery code format.");
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`jackboy-recovery:${userId}:${n}`));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}
export function recoveryRateLimited(recentFailures: number): boolean {
  return recentFailures >= RECOVERY_ATTEMPT_LIMIT;
}
/** Generating new codes needs a session already verified with the authenticator (aal2). */
export function canGenerateCodes(aal: unknown): boolean {
  return aal === "aal2";
}

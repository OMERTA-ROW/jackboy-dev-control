/** New work serves a user-visible feature; tests never become an unrelated backlog. */
import { GUIDELINES_PROMPT } from "./guidelines";
export const WORK_FOCUS = GUIDELINES_PROMPT + "\n\n" + "Prioritize real features and fixes. Do not propose standalone add-tests or test-fixture tasks unless they block a named real feature. Add new tests only for security/auth, approvals/passkeys, payments, GitHub/OMNI connections or data integrity. Always run the existing test suite for the exact changed commit before a draft PR; missing or pending execution blocks the PR.";
export const CREDIT_PAUSE = "Paused: out of credits";
export const CREDIT_HELP_URL = "https://docs.lovable.dev/introduction/credits-and-usage#view-your-credit-balance";
export function isCreditError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: number; statusCode?: number; httpStatus?: number; code?: string; message?: string };
  return [e.status, e.statusCode, e.httpStatus].includes(402) || e.code === "payment_required" || /(?:out of|insufficient|not enough) credits|payment required|AI request failed \(402\)/i.test(e.message ?? "");
}
export function standaloneTestTask(title: string, paths: string[], blockedFeature?: string | null): boolean {
  if (blockedFeature?.trim()) return false;
  const testOnly = paths.length > 0 && paths.every((p) => /(?:^|\/)(?:tests?|__tests__|fixtures?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p));
  return testOnly || /^(?:add|write|expand|improve|fix|repair|update)\s+(?:(?:a|the|more|unit|integration|regression|test)\s+)*(?:tests?\b|test fixtures?\b|fixtures?\b|test coverage\b)/i.test(title.trim());
}
export function existingTestsPassed(runs: { status: string; conclusion: string | null }[], configured: number, error?: string): boolean {
  return !error && configured > 0 && runs.length > 0 && runs.every((r) => r.status === "completed" && r.conclusion === "success");
}
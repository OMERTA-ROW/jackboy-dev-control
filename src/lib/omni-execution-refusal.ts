/**
 * Pure rules for classifying failures on the signed execution-control path
 * (`omni-execution.server.ts`). A known precondition refusal gets its own nonsecret
 * reason code and a 4xx status; only genuine unavailability stays 503. Every result
 * still fails closed: nothing here grants, arms, configures or retries anything.
 */

/** Must match the 15-minute window enforced by `omni_execution_control_without_lease`. */
export const EXECUTOR_VERIFICATION_WINDOW_MS = 15 * 60_000;

export type ExecutionStage =
  | "request"
  | "nonce"
  | "approval"
  | "readiness"
  | "executor"
  | "verification"
  | "failure_stop"
  | "authority"
  | "respond"
  | "cancellation";

export type Refusal = { status: number; error: string };

/** Database exception messages raised by `omni_execution_control*` (migrations 0068/0069). */
const AUTHORITY_REFUSALS: Array<[string, Refusal]> = [
  ["Fresh Jackboy owner authorization required", { status: 403, error: "owner_authorization_required" }],
  ["Connection is not authorized", { status: 409, error: "connection_not_authorized" }],
  ["CODE spend enforcement is not verified", { status: 409, error: "spend_enforcement_unverified" }],
  ["Execution is blocked", { status: 409, error: "execution_blocked" }],
  ["Execution authority denied", { status: 403, error: "project_or_action_denied" }],
];

/** Maps a database refusal message to a precise reason; unknown messages return null (stay 503). */
export function classifyAuthorityError(message: string | null | undefined): Refusal | null {
  if (!message) return null;
  for (const [prefix, refusal] of AUTHORITY_REFUSALS) {
    if (message.startsWith(prefix)) return refusal;
  }
  return null;
}

/** `assertCodeConfigurationReady` raises this message only when a readiness gate is not met. */
export const CODE_NOT_READY_MESSAGE =
  "CODE gateway, workflow identity or spending enforcement is not ready";

export function classifyReadinessError(message: string | null | undefined): Refusal | null {
  return message === CODE_NOT_READY_MESSAGE
    ? { status: 409, error: "code_configuration_not_ready" }
    : null;
}

/**
 * Step 10 (configure) needs a recorded executor verification for this connection that is
 * at most 15 minutes old and names the same release the executor reports now. A fresh
 * `connect` clears it, so Mothership must call `verify` between Step 9 and Step 10.
 */
export function executorVerificationFresh(
  row: { verifiedAt: string | null; executorRelease: string | null } | null,
  release: string,
  now: number,
): boolean {
  if (!row?.verifiedAt || row.executorRelease !== release) return false;
  const at = Date.parse(row.verifiedAt);
  return Number.isFinite(at) && at <= now + 5_000 && now - at < EXECUTOR_VERIFICATION_WINDOW_MS;
}

/** Short, redacted diagnostic for audit rows and server logs (never returned to the caller). */
export function failureDetail(
  error: unknown,
  redact: (s: string) => string,
): { name: string; code: string | null; message: string } {
  const e = (error ?? {}) as { name?: unknown; code?: unknown; message?: unknown };
  const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 199)}…` : s);
  return {
    name: typeof e.name === "string" ? clip(e.name) : "Error",
    code: typeof e.code === "string" ? clip(redact(e.code)) : null,
    message: typeof e.message === "string" ? clip(redact(e.message)) : "",
  };
}

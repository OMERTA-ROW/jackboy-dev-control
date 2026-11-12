// Pure rules for the Evolution Mothership → Jackboy handoff (contract jackboy.omni-handoff/v1).
// The endpoint only records an owner-approved held task as a QUEUED Jackboy job; it never
// sends anything to OMNI. Jackboy's per-job passkey approval, Kill Switch, project
// authorization and spend caps stay in front of any later dispatch.
import { z } from "zod";

export const HANDOFF_CONTRACT = "jackboy.omni-handoff/v1";
export const HANDOFF_PATH = "/api/public/omni-handoff/v1";
export const HANDOFF_MAX_BODY_BYTES = 8192;
export const HANDOFF_MAX_SKEW_MS = 60_000;
export const HANDOFF_MIN_SECRET_LENGTH = 32;

export type HandoffSettings = { clientId: string; secret: string };

/** Off unless JACKBOY_HANDOFF_ENABLED is exactly "true" and the client/secret are well formed. */
export function handoffConfig(env: Record<string, string | undefined>): HandoffSettings | null {
  if (env["JACKBOY_HANDOFF_ENABLED"] !== "true") return null;
  const clientId = env["JACKBOY_HANDOFF_CLIENT_ID"] || "";
  const secret = env["JACKBOY_HANDOFF_HMAC_SECRET"] || "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientId) || secret.length < HANDOFF_MIN_SECRET_LENGTH)
    return null;
  return { clientId, secret };
}

const uuid = z.string().uuid();
export const handoffCreateSchema = z
  .object({
    action: z.literal("create"),
    taskId: uuid,
    projectId: uuid,
    repo: z
      .string()
      .max(200)
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    kind: z.enum(["test", "code"]),
    instructions: z.string().min(3).max(4000),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const handoffStatusSchema = z.object({ action: z.literal("status"), taskId: uuid }).strict();
export const handoffRequestSchema = z.discriminatedUnion("action", [
  handoffCreateSchema,
  handoffStatusSchema,
]);
export type HandoffCreate = z.infer<typeof handoffCreateSchema>;
export type HandoffRequest = z.infer<typeof handoffRequestSchema>;

/** Exact bytes the caller signs with HMAC-SHA256. */
export function handoffSigningInput(
  client: string,
  timestamp: string,
  nonce: string,
  body: string,
): string {
  return `${HANDOFF_CONTRACT}\nPOST\n${HANDOFF_PATH}\n${client}\n${timestamp}\n${nonce}\n${body}`;
}

/** Exact bytes Jackboy signs for the X-Jackboy-Proof response header. */
export function handoffResponseInput(nonce: string, httpStatus: number, body: string): string {
  return `${HANDOFF_CONTRACT}\nresponse\n${nonce}\n${httpStatus}\n${body}`;
}

export function handoffClockOk(timestamp: string, now: number): boolean {
  return (
    /^[0-9]{10}$/.test(timestamp) && Math.abs(now - Number(timestamp) * 1000) <= HANDOFF_MAX_SKEW_MS
  );
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const KNOWN_STATUSES = new Set([
  "queued",
  "sent",
  "prepared",
  "approved",
  "quarantined",
  "running",
  "completed",
  "failed",
  "expired",
  "cancel_requested",
  "cancelled",
]);

/** Dispatch v3 state (when the owner later approved and sent the job) wins over the queue row. */
export function handoffPublicStatus(
  jobStatus: string | null | undefined,
  v3Status: string | null | undefined,
): string {
  const value = v3Status || jobStatus || "";
  return KNOWN_STATUSES.has(value) ? value : "unknown";
}

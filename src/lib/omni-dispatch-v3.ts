// Pure rules for Jackboy scoped dispatch v3 (contract shared with OMNI's matching v3 change).
// v2 stays byte-for-byte unchanged; v3 adds a signed payload + expiry on submit, wider job states
// and a bounded result on completed/failed callbacks.
import { z } from "zod";

export const DISPATCH_V2 = "jackboy.dispatch/v2";
export const DISPATCH_V3 = "jackboy.dispatch/v3";
export const CALLBACK_V2 = "jackboy.dispatch-callback/v2";
export const CALLBACK_V3 = "jackboy.dispatch-callback/v3";
export type DispatchVersion = "v2" | "v3";

export const MAX_PAYLOAD_BYTES = 6 * 1024;
export const MAX_OUTPUT_BYTES = 6 * 1024;
export const MAX_SUMMARY_CHARS = 500;
export const MAX_EXPIRY_SECONDS = 30 * 60;

/** States OMNI may report in a v3 dispatch response. */
export const V3_JOB_STATUSES = [
  "quarantined",
  "approved",
  "running",
  "completed",
  "failed",
  "cancelled",
  "expired",
] as const;
/** States OMNI may report in a v3 callback (never "approved"). */
export const V3_CALLBACK_STATUSES = [
  "quarantined",
  "cancelled",
  "running",
  "completed",
  "failed",
  "expired",
] as const;
export type V3JobStatus = (typeof V3_JOB_STATUSES)[number];

export const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

/** The grant's instructions sent as the signed v3 payload; anything over 6 KB is refused. */
export function v3Payload(instructions: string): string {
  if (utf8Bytes(instructions) > MAX_PAYLOAD_BYTES)
    throw new Error("Job instructions are larger than 6 KB, so the v3 dispatch was refused.");
  return instructions;
}

/** Unix seconds of the grant's expiry; must be in the future and at most 30 minutes out. */
export function v3ExpiresAt(grantExpiresAt: string | number, nowMs = Date.now()): number {
  const ms = typeof grantExpiresAt === "number" ? grantExpiresAt * 1000 : Date.parse(grantExpiresAt);
  if (!Number.isFinite(ms)) throw new Error("The approval's expiry could not be read.");
  return assertV3Expiry(Math.floor(ms / 1000), nowMs);
}

export function assertV3Expiry(expiresAt: number, nowMs = Date.now()): number {
  const now = Math.floor(nowMs / 1000);
  if (!Number.isInteger(expiresAt) || expiresAt <= now)
    throw new Error("The approval has expired, so the v3 dispatch was refused.");
  if (expiresAt > now + MAX_EXPIRY_SECONDS)
    throw new Error("The approval expires more than 30 minutes out, so the v3 dispatch was refused.");
  return expiresAt;
}

export const v3ResultSchema = z
  .object({
    passed: z.boolean(),
    summary: z.string().max(MAX_SUMMARY_CHARS),
    output: z.string().refine((s) => utf8Bytes(s) <= MAX_OUTPUT_BYTES, "output over 6 KB"),
    truncated: z.boolean(),
  })
  .strict();
export type V3Result = z.infer<typeof v3ResultSchema>;

export type SafetyInput = {
  /** Global Kill Switch; null = unreadable. */
  paused: boolean | null;
  /** CODE runtime controls; null = unreadable. */
  controls: {
    kill_switch: boolean | null;
    usage_spike: boolean | null;
    consecutive_failures: number | null;
    daily_spend_limit_usd: number | string | null;
  } | null;
  /** Today's recorded CODE spend in USD; null = unreadable. */
  todaySpendUsd: number | null;
  allowedRepos: string[];
  repo: string;
};

/** Guardian, Emergency Stop and spending gate in front of every v3 dispatch. Fails closed. */
export function v3SafetyGate(input: SafetyInput): string | null {
  if (input.paused !== false) return "The Kill Switch is on or can't be read, so nothing is sent.";
  const c = input.controls;
  if (!c || typeof c.kill_switch !== "boolean")
    return "Emergency Stop state can't be read, so nothing is sent.";
  if (c.kill_switch) return "Emergency Stop is engaged, so nothing is sent.";
  if (c.usage_spike !== false) return "A spending spike is flagged or unreadable, so nothing is sent.";
  if (typeof c.consecutive_failures !== "number" || c.consecutive_failures >= 2)
    return "The two-failure stop is active or unreadable, so nothing is sent.";
  const limit = Number(c.daily_spend_limit_usd);
  if (!Number.isFinite(limit) || limit <= 0 || input.todaySpendUsd === null)
    return "Spending limits can't be read, so nothing is sent.";
  if (input.todaySpendUsd >= limit) return "Today's spending limit is reached, so nothing is sent.";
  if (!input.allowedRepos.length)
    return "OMNI_ALLOWED_REPOS is empty or invalid, so no OMNI repository is authorized.";
  if (!input.allowedRepos.includes(input.repo))
    return `${input.repo} is not on Jackboy's OMNI repository list (OMNI_ALLOWED_REPOS).`;
  return null;
}

export type V3JobRecord = {
  status: string;
  result: unknown;
  result_at: string | null;
  updated_at: string;
  last_source: string;
} | null;

/** Plain-language view of the stored v3 record. Never guesses: no stored result means "no result". */
export function describeV3Job(record: V3JobRecord) {
  if (!record)
    return {
      status: null,
      headline: "OMNI has not reported anything for this job yet.",
      outcome: null as null | "passed" | "failed",
      summary: null as string | null,
      output: null as string | null,
      truncated: false,
      noResult: "No result came back from OMNI.",
    };
  const parsed = v3ResultSchema.safeParse(record.result);
  const result = parsed.success ? parsed.data : null;
  const finished = ["completed", "failed", "cancelled", "expired"].includes(record.status);
  return {
    status: record.status,
    headline: `OMNI status: ${record.status}`,
    outcome: result ? (result.passed ? ("passed" as const) : ("failed" as const)) : null,
    summary: result?.summary ?? null,
    output: result?.output ?? null,
    truncated: result?.truncated ?? false,
    noResult: result
      ? null
      : finished
        ? "No result came back from OMNI."
        : "No result yet — OMNI hasn't finished this job.",
  };
}

// Pure rules for the owner-only "OMNI link values" view. These three values identify the one
// owner/approval OMNI may link under, so Railway must carry exactly the same strings as Jackboy.
// The summary never includes the values themselves; only the passkey-gated reveal returns them.
import { UUID } from "./omni-session";

export const LINK_VALUE_NAMES = ["OMNI_LINK_OWNER_ID", "OMNI_LINK_APPROVAL_ID", "OMNI_LINK_APPROVAL_EXPIRES_AT"] as const;
export type LinkValueName = (typeof LINK_VALUE_NAMES)[number];
/** Matches `linkConfig()`: an approval may expire at most 24 hours ahead. */
export const MAX_APPROVAL_MS = 86_400_000;
/** New approvals are suggested slightly under the limit so clock drift never makes them invalid. */
export const SUGGESTED_APPROVAL_MS = 23 * 3_600_000;
export const REVEAL_ACTION = "omni_link_values";
export const REVEAL_TARGET = "omni-link-values";

export type ValueCheck = { name: LinkValueName; present: boolean; ok: boolean; problem: string | null };
export type LinkValueSummary = {
  checks: ValueCheck[];
  ownerMatchesYou: boolean;
  expiry: "missing" | "invalid" | "expired" | "too_far" | "valid";
  expiresInMs: number | null;
  allReady: boolean;
};

/** Same rule as `linkConfig()`: missing, unparseable, past, more than 24h ahead, or valid. */
export function approvalExpiryState(raw: string | undefined, now = Date.now()): LinkValueSummary["expiry"] {
  const v = (raw ?? "").trim();
  const t = Date.parse(v);
  return !v ? "missing" : !Number.isFinite(t) ? "invalid" : t <= now ? "expired" : t > now + MAX_APPROVAL_MS ? "too_far" : "valid";
}

/** Value-free wording for readiness and status lines. */
export const APPROVAL_EXPIRY_TEXT: Record<LinkValueSummary["expiry"], string> = {
  missing: "OMNI_LINK_APPROVAL_EXPIRES_AT is not saved in Jackboy",
  invalid: "OMNI_LINK_APPROVAL_EXPIRES_AT saved in Jackboy is not a valid date and time",
  expired: "OMNI_LINK_APPROVAL_EXPIRES_AT saved in Jackboy has expired",
  too_far: "OMNI_LINK_APPROVAL_EXPIRES_AT saved in Jackboy is more than 24 hours ahead",
  valid: "OMNI_LINK_APPROVAL_EXPIRES_AT saved in Jackboy is within the next 24 hours",
};

export function summarizeLinkValues(env: Record<string, string | undefined>, ownerUserId: string, now = Date.now()): LinkValueSummary {
  const owner = (env["OMNI_LINK_OWNER_ID"] ?? "").trim();
  const approval = (env["OMNI_LINK_APPROVAL_ID"] ?? "").trim();
  const expiresRaw = (env["OMNI_LINK_APPROVAL_EXPIRES_AT"] ?? "").trim();
  const t = Date.parse(expiresRaw);
  const expiry = approvalExpiryState(expiresRaw, now);
  const ownerMatchesYou = owner.length > 0 && owner.toLowerCase() === ownerUserId.toLowerCase();
  const checks: ValueCheck[] = [
    {
      name: "OMNI_LINK_OWNER_ID",
      present: owner.length > 0,
      ok: UUID.test(owner) && ownerMatchesYou,
      problem: !owner ? "Not set in Jackboy" : !UUID.test(owner) ? "Not a valid ID" : !ownerMatchesYou ? "Does not match your owner account" : null,
    },
    {
      name: "OMNI_LINK_APPROVAL_ID",
      present: approval.length > 0,
      ok: UUID.test(approval),
      problem: !approval ? "Not set in Jackboy" : !UUID.test(approval) ? "Not a valid ID" : null,
    },
    {
      name: "OMNI_LINK_APPROVAL_EXPIRES_AT",
      present: expiresRaw.length > 0,
      ok: expiry === "valid",
      problem:
        expiry === "missing"
          ? "Not set in Jackboy"
          : expiry === "invalid"
            ? "Not a valid date and time"
            : expiry === "expired"
              ? "Expired — the link refuses OMNI until a new approval is saved"
              : expiry === "too_far"
                ? "More than 24 hours ahead — the link refuses it"
                : null,
    },
  ];
  return {
    checks,
    ownerMatchesYou,
    expiry,
    expiresInMs: Number.isFinite(t) ? t - now : null,
    allReady: checks.every((c) => c.ok),
  };
}

/** Relative, value-free description of the saved approval expiry. */
export function expiryHint(expiry: LinkValueSummary["expiry"], inMs: number | null): string {
  const hours = inMs === null ? null : Math.round(Math.abs(inMs) / 360_000) / 10;
  switch (expiry) {
    case "valid": return `Saved approval is valid for about ${hours} more hours.`;
    case "expired": return `Saved approval expired about ${hours} hours ago.`;
    case "too_far": return `Saved approval ends about ${hours} hours from now — more than the 24-hour limit, so the link refuses it.`;
    case "invalid": return "Saved approval expiry is not a valid date and time.";
    default: return "No approval expiry is saved in Jackboy.";
  }
}

/** An expiry the save accepts must name its time zone (Z or ±hh:mm); otherwise the browser reads it as local time. */
const HAS_ZONE = /(Z|[+-]\d{2}:?\d{2})$/i;

/** Value-free reason a typed/pasted expiry cannot be saved (null = savable). Same 24-hour rule as
 * the server and database; the browser runs it before the passkey prompt so a doomed save never asks for a tap. */
export function approvalSaveProblem(raw: string | undefined, now = Date.now()): string | null {
  const v = (raw ?? "").trim();
  if (!v) return "Enter the approval expiry.";
  if (!HAS_ZONE.test(v) || !Number.isFinite(Date.parse(v)))
    return "The expiry must be a full date and time with a time zone, like 2026-11-09T07:00:00.000Z.";
  const state = approvalExpiryState(v, now);
  if (state === "valid") return null;
  const ms = Math.abs(Date.parse(v) - now);
  const ago = ms < 3_600_000 ? "less than an hour" : `about ${Math.round(ms / 360_000) / 10} hours`;
  return state === "expired"
    ? `This expiry passed ${ago} ago, so it can't be saved. Press “Make a new approval”, save that pair, then copy the same pair into Railway.`
    : `This expiry is ${ago} ahead; the limit is 24 hours. Press “Make a new approval” instead.`;
}

/** A fresh approval pair for the owner to save in BOTH Jackboy and Railway. Nothing is stored. */
export function suggestApproval(now = Date.now(), uuid: () => string = () => crypto.randomUUID()) {
  return { approvalId: uuid(), expiresAt: new Date(now + SUGGESTED_APPROVAL_MS).toISOString() };
}

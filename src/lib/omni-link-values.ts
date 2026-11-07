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

export function summarizeLinkValues(env: Record<string, string | undefined>, ownerUserId: string, now = Date.now()): LinkValueSummary {
  const owner = (env.OMNI_LINK_OWNER_ID ?? "").trim();
  const approval = (env.OMNI_LINK_APPROVAL_ID ?? "").trim();
  const expiresRaw = (env.OMNI_LINK_APPROVAL_EXPIRES_AT ?? "").trim();
  const t = Date.parse(expiresRaw);
  const expiry: LinkValueSummary["expiry"] = !expiresRaw
    ? "missing"
    : !Number.isFinite(t)
      ? "invalid"
      : t <= now
        ? "expired"
        : t > now + MAX_APPROVAL_MS
          ? "too_far"
          : "valid";
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

/** A fresh approval pair for the owner to save in BOTH Jackboy and Railway. Nothing is stored. */
export function suggestApproval(now = Date.now(), uuid: () => string = () => crypto.randomUUID()) {
  return { approvalId: uuid(), expiresAt: new Date(now + SUGGESTED_APPROVAL_MS).toISOString() };
}

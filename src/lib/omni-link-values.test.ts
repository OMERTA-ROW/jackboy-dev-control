import { describe, expect, it } from "vitest";
import { MAX_APPROVAL_MS, suggestApproval, summarizeLinkValues } from "./omni-link-values";
import { FRESH_ONLY_ACTIONS, STEP_UP_ACTIONS, mayRequest } from "./step-up";

const me = "11111111-1111-4111-8111-111111111111";
const approval = "22222222-2222-4222-8222-222222222222";
const now = Date.parse("2026-11-07T18:00:00Z");
const env = (o: Record<string, string | undefined> = {}) => ({
  OMNI_LINK_OWNER_ID: me,
  OMNI_LINK_APPROVAL_ID: approval,
  OMNI_LINK_APPROVAL_EXPIRES_AT: "2026-11-08T10:00:00Z",
  ...o,
});

describe("OMNI link values summary", () => {
  it("is ready when owner matches, approval is a UUID and expiry is within 24 hours", () => {
    const s = summarizeLinkValues(env(), me, now);
    expect(s.allReady).toBe(true);
    expect(s.expiry).toBe("valid");
  });

  it("never contains the values themselves", () => {
    const text = JSON.stringify(summarizeLinkValues(env(), me, now));
    expect(text).not.toContain(approval);
    expect(text).not.toContain(me);
  });

  it("flags an owner ID that is not the signed-in owner", () => {
    const s = summarizeLinkValues(env({ OMNI_LINK_OWNER_ID: approval }), me, now);
    expect(s.ownerMatchesYou).toBe(false);
    expect(s.allReady).toBe(false);
  });

  it("treats a past expiry as expired", () => {
    expect(summarizeLinkValues(env({ OMNI_LINK_APPROVAL_EXPIRES_AT: "2026-11-07T17:59:59Z" }), me, now).expiry).toBe("expired");
  });

  it("refuses an expiry more than 24 hours ahead", () => {
    const far = new Date(now + MAX_APPROVAL_MS + 1000).toISOString();
    expect(summarizeLinkValues(env({ OMNI_LINK_APPROVAL_EXPIRES_AT: far }), me, now).expiry).toBe("too_far");
  });

  it("reports missing values by name", () => {
    const s = summarizeLinkValues({}, me, now);
    expect(s.checks.every((c) => !c.present)).toBe(true);
    expect(s.expiry).toBe("missing");
  });

  it("suggests a new approval that the link would accept (under 24 hours ahead)", () => {
    const n = suggestApproval(now, () => approval);
    expect(n.approvalId).toBe(approval);
    const s = summarizeLinkValues(env({ OMNI_LINK_APPROVAL_EXPIRES_AT: n.expiresAt }), me, now);
    expect(s.expiry).toBe("valid");
  });
});

describe("reveal passkey rule", () => {
  it("is owner-only and always needs a fresh passkey", () => {
    expect(STEP_UP_ACTIONS.omni_link_values.roles).toEqual(["owner"]);
    expect(mayRequest("omni_link_values", "admin").ok).toBe(false);
    expect((FRESH_ONLY_ACTIONS as readonly string[]).includes("omni_link_values")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { MAX_APPROVAL_MS, approvalExpiryState, approvalSaveProblem, expiryHint, suggestApproval, summarizeLinkValues } from "./omni-link-values";
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

describe("OMNI approval status follows the saved value", () => {
  const owner = "93a2e690-a179-4d08-bd68-a3a793fced11";
  const now = Date.parse("2026-11-08T08:00:00Z");
  const env = (expires: string) => ({
    OMNI_LINK_OWNER_ID: owner,
    OMNI_LINK_APPROVAL_ID: "0b6f3c1e-2a4d-4e8f-9c1a-1234567890ab",
    OMNI_LINK_APPROVAL_EXPIRES_AT: expires,
  });
  it("re-reads on every check, so a newly saved expiry turns an expired status valid", () => {
    expect(summarizeLinkValues(env("2026-11-06T22:00:00Z"), owner, now).expiry).toBe("expired");
    expect(summarizeLinkValues(env("2026-11-09T06:00:00Z"), owner, now).expiry).toBe("valid");
  });
  it("matches the link gate's boundaries exactly", () => {
    expect(approvalExpiryState("2026-11-08T08:00:00Z", now)).toBe("expired");
    expect(approvalExpiryState("2026-11-09T08:00:00Z", now)).toBe("valid");
    expect(approvalExpiryState("2026-11-09T08:00:00.001Z", now)).toBe("too_far");
    expect(approvalExpiryState("  ", now)).toBe("missing");
    expect(approvalExpiryState("08/11/2026 9am", now)).toBe("invalid");
  });
  it("respects time zones written into the value", () => {
    expect(approvalExpiryState("2026-11-08T03:00:00-05:00", now)).toBe("expired");
    expect(approvalExpiryState("2026-11-08T03:00:01-05:00", now)).toBe("valid");
  });
  it("describes expiry relative to now without showing the value", () => {
    const s = summarizeLinkValues(env("2026-11-06T21:30:00Z"), owner, now);
    const hint = expiryHint(s.expiry, s.expiresInMs);
    expect(hint).toBe("Saved approval expired about 34.5 hours ago.");
    expect(hint).not.toContain("2026");
  });
});

describe("approvalSaveProblem (checked before the passkey prompt and again on the server)", () => {
  it("accepts a fresh suggested pair", () => {
    expect(approvalSaveProblem(suggestApproval(now).expiresAt, now)).toBeNull();
  });
  it("refuses an expiry that already passed and points to a new pair", () => {
    const p = approvalSaveProblem("2026-11-07T08:00:00Z", now);
    expect(p).toContain("passed about 10 hours ago");
    expect(p).toContain("Make a new approval");
  });
  it("refuses an expiry exactly at now (same rule as the database)", () => {
    expect(approvalSaveProblem(new Date(now).toISOString(), now)).toContain("passed");
  });
  it("refuses an expiry more than 24 hours ahead", () => {
    expect(approvalSaveProblem(new Date(now + MAX_APPROVAL_MS + 60_000).toISOString(), now)).toContain("limit is 24 hours");
  });
  it("refuses a date without a time zone instead of guessing local time", () => {
    expect(approvalSaveProblem("2026-11-08T10:00:00", now)).toContain("time zone");
  });
  it("accepts an offset other than Z by its real instant", () => {
    expect(approvalSaveProblem("2026-11-08T05:00:00-05:00", now)).toBeNull();
  });
  it("refuses empty input", () => {
    expect(approvalSaveProblem("  ", now)).toBe("Enter the approval expiry.");
  });
});

import { describe, expect, it } from "vitest";
import { linkRefusal, REFUSAL_TEXT } from "./omni-link-refusal";

const now = Date.parse("2026-11-08T03:00:00Z");
const ok = {
  OMNI_LINK_ENABLED: "true",
  OMNI_LINK_CLIENT_ID: "omni",
  OMNI_LINK_PROJECT_ID: "11111111-1111-4111-8111-111111111111",
  OMNI_LINK_OWNER_ID: "22222222-2222-4222-8222-222222222222",
  OMNI_LINK_APPROVAL_ID: "33333333-3333-4333-8333-333333333333",
  OMNI_LINK_APPROVAL_EXPIRES_AT: "2026-11-08T20:00:00Z",
  OMNI_LINK_BOOTSTRAP_KEY: "b".repeat(40),
  OMNI_LINK_HMAC_SECRET: "s".repeat(40),
};

describe("linkRefusal", () => {
  it("valid config has no refusal", () => expect(linkRefusal(ok, now)).toBeNull());
  it("expiry 28 hours in the past is approval_expired", () =>
    expect(linkRefusal({ ...ok, OMNI_LINK_APPROVAL_EXPIRES_AT: "2026-11-06T23:00:00Z" }, now)).toBe("approval_expired"));
  it("expiry more than 24 hours ahead is refused", () =>
    expect(linkRefusal({ ...ok, OMNI_LINK_APPROVAL_EXPIRES_AT: "2026-11-09T04:00:00Z" }, now)).toBe("approval_expiry_too_far"));
  it("switch not exactly true is link_switch_off", () =>
    expect(linkRefusal({ ...ok, OMNI_LINK_ENABLED: "TRUE" }, now)).toBe("link_switch_off"));
  it("quoted expiry is not a date", () =>
    expect(linkRefusal({ ...ok, OMNI_LINK_APPROVAL_EXPIRES_AT: '"2026-11-08T20:00:00Z"' }, now)).toBe("approval_expiry_invalid"));
  it("reason text never contains a value", () => {
    const r = linkRefusal({ ...ok, OMNI_LINK_APPROVAL_EXPIRES_AT: "2026-11-06T23:00:00Z" }, now)!;
    expect(REFUSAL_TEXT[r]).not.toContain("2026");
  });
});

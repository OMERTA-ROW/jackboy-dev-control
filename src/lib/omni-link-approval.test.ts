import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveApproval, saveErrorText, withApproval, SAVE_APPROVAL_ACTION } from "./omni-link-approval";
import { summarizeLinkValues } from "./omni-link-values";
import { linkConfig } from "./omni-session.server";
import { FRESH_ONLY_ACTIONS, mayRequest, recentEligible } from "./step-up";

const owner = "11111111-1111-4111-8111-111111111111";
const legacy = { OMNI_LINK_APPROVAL_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", OMNI_LINK_APPROVAL_EXPIRES_AT: "2026-11-06T22:00:00Z" };
const row = (expires: string) => ({ approval_id: "33333333-3333-4333-8333-333333333333", expires_at: expires, saved_at: "2026-11-08T08:00:00Z" });

describe("OMNI link approval precedence", () => {
  it("a saved record wins over the legacy settings", () => {
    const a = resolveApproval({ ok: true, row: row("2026-11-09T06:00:00Z") }, legacy);
    expect(a.source).toBe("database");
    expect(a.approvalId).toBe("33333333-3333-4333-8333-333333333333");
  });
  it("an expired saved record never falls back to the legacy settings", () => {
    const valid = { ...legacy, OMNI_LINK_APPROVAL_EXPIRES_AT: "2026-11-09T06:00:00Z" };
    const a = resolveApproval({ ok: true, row: row("2026-11-07T00:00:00Z") }, valid);
    expect(a.source).toBe("database");
    expect(summarizeLinkValues(withApproval({ OMNI_LINK_OWNER_ID: owner }, a), owner, Date.parse("2026-11-08T08:00:00Z")).expiry).toBe("expired");
  });
  it("uses legacy settings only when no record is saved", () => {
    expect(resolveApproval({ ok: true, row: null }, legacy)).toMatchObject({ source: "legacy_env", approvalId: legacy.OMNI_LINK_APPROVAL_ID });
  });
  it("fails closed when the saved record cannot be read", () => {
    const a = resolveApproval({ ok: false }, legacy);
    expect(a).toMatchObject({ source: "unavailable", approvalId: "", expiresAt: "" });
    expect(summarizeLinkValues(withApproval({ OMNI_LINK_OWNER_ID: owner }, a), owner).expiry).toBe("missing");
  });
});

describe("link gate uses the effective approval", () => {
  afterEach(() => vi.unstubAllEnvs());
  const stubLink = () => {
    vi.stubEnv("OMNI_LINK_ENABLED", "true");
    vi.stubEnv("OMNI_LINK_CLIENT_ID", "omni");
    vi.stubEnv("OMNI_LINK_PROJECT_ID", "22222222-2222-4222-8222-222222222222");
    vi.stubEnv("OMNI_LINK_OWNER_ID", owner);
    vi.stubEnv("OMNI_LINK_BOOTSTRAP_KEY", "b".repeat(40));
    vi.stubEnv("OMNI_LINK_HMAC_SECRET", "s".repeat(40));
    vi.stubEnv("OMNI_LINK_APPROVAL_ID", legacy.OMNI_LINK_APPROVAL_ID);
    vi.stubEnv("OMNI_LINK_APPROVAL_EXPIRES_AT", "2020-01-01T00:00:00Z");
  };
  it("accepts a fresh saved approval even when the legacy setting is expired", () => {
    stubLink();
    const a = resolveApproval({ ok: true, row: row(new Date(Date.now() + 3_600_000).toISOString()) }, process.env);
    expect(linkConfig({ approvalId: a.approvalId, approvalExpiresAt: a.expiresAt })?.approvalId).toBe(a.approvalId);
  });
  it("refuses when the saved record is unreadable, expired, or more than 24 hours ahead", () => {
    stubLink();
    for (const read of [
      { ok: false } as const,
      { ok: true, row: row(new Date(Date.now() - 1000).toISOString()) } as const,
      { ok: true, row: row(new Date(Date.now() + 25 * 3_600_000).toISOString()) } as const,
    ]) {
      const a = resolveApproval(read, process.env);
      expect(linkConfig({ approvalId: a.approvalId, approvalExpiresAt: a.expiresAt })).toBeNull();
    }
  });
  it("a saved approval never turns the link on by itself", () => {
    stubLink();
    vi.stubEnv("OMNI_LINK_ENABLED", "");
    const a = resolveApproval({ ok: true, row: row(new Date(Date.now() + 3_600_000).toISOString()) }, process.env);
    expect(linkConfig({ approvalId: a.approvalId, approvalExpiresAt: a.expiresAt })).toBeNull();
  });
});

describe("saving an approval is owner-only with a fresh passkey", () => {
  it("is owner-only, fresh-only and never grace-eligible", () => {
    expect(mayRequest(SAVE_APPROVAL_ACTION, "owner").ok).toBe(true);
    expect(mayRequest(SAVE_APPROVAL_ACTION, "admin").ok).toBe(false);
    expect(mayRequest(SAVE_APPROVAL_ACTION, null).ok).toBe(false);
    expect((FRESH_ONLY_ACTIONS as readonly string[]).includes(SAVE_APPROVAL_ACTION)).toBe(true);
    expect(recentEligible(SAVE_APPROVAL_ACTION, "omni-link-approval")).toBe(false);
  });
  it("explains database refusals without leaking raw errors", () => {
    expect(saveErrorText("Owner required")).toMatch(/Only the owner/);
    expect(saveErrorText("Fresh passkey confirmation required")).toMatch(/new passkey/);
    expect(saveErrorText("Approval expiry must be within 24 hours")).toMatch(/24 hours/);
    expect(saveErrorText('relation "x" does not exist at secret-host')).toBe("Jackboy could not save the approval.");
  });
});

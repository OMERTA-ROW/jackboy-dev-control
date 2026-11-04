import { describe, expect, it } from "vitest";
import { grantUsable, mayRequest } from "./step-up";

const g = { user_id: "u", action: "merge_update", target: "p1", expires_at: new Date(Date.now() + 60_000).toISOString(), used_at: null };
describe("passkey step-up", () => {
  it("removing an owner device needs owner permission and its exact scoped grant", () => {
    expect(mayRequest("remove_passkey", "owner").ok).toBe(true);
    expect(mayRequest("remove_passkey", "member").ok).toBe(false);
    const removal = { ...g, action: "remove_passkey", target: "passkey:device1" };
    expect(grantUsable(removal, "u", "remove_passkey", "passkey:device1")).toBe(true);
    expect(grantUsable(removal, "u", "remove_passkey", "passkey:device2")).toBe(false);
  });
  it("owner may request a merge step-up", () => expect(mayRequest("merge_update", "owner").ok).toBe(true));
  it("admins and members may not, even with a passkey", () => {
    expect(mayRequest("merge_update", "admin").ok).toBe(false);
    expect(mayRequest("merge_update", "member").ok).toBe(false);
  });
  it("production deployment is owner-only and physical controls stay blocked", () => {
    expect(mayRequest("production_deploy", "owner").ok).toBe(true);
    expect(mayRequest("production_deploy", "admin").ok).toBe(false);
    expect(mayRequest("building_control", "owner").ok).toBe(false);
  });
  it("permission increases require an owner or administrator", () => {
    expect(mayRequest("privilege_escalation", "owner").ok).toBe(true);
    expect(mayRequest("privilege_escalation", "admin").ok).toBe(true);
    expect(mayRequest("privilege_escalation", "member").ok).toBe(false);
  });
  it("a grant works only for its exact action and target", () => {
    expect(grantUsable(g, "u", "merge_update", "p1")).toBe(true);
    expect(grantUsable(g, "u", "merge_update", "p2")).toBe(false);
    expect(grantUsable(g, "u", "revert_update", "p1")).toBe(false);
    expect(grantUsable(g, "other", "merge_update", "p1")).toBe(false);
  });
  it("used or expired grants are rejected", () => {
    expect(grantUsable({ ...g, used_at: new Date().toISOString() }, "u", "merge_update", "p1")).toBe(false);
    expect(grantUsable({ ...g, expires_at: new Date(Date.now() - 1).toISOString() }, "u", "merge_update", "p1")).toBe(false);
  });
});

import { recentEligible, recentVerificationValid, RECENT_VERIFICATION_MS } from "./step-up";
describe("recent passkey verification", () => {
  it("only routine connection reviews may reuse a recent check", () => {
    expect(recentEligible("approve_integration", "repository_resync:abc")).toBe(true);
    expect(recentEligible("approve_integration", "github_repo:p1")).toBe(true);
    expect(recentEligible("merge_update", "github_repo:p1")).toBe(false);
    expect(recentEligible("production_deploy", "x")).toBe(false);
    expect(recentEligible("remove_passkey", "x")).toBe(false);
    expect(recentEligible("critical_change", "x")).toBe(false);
    expect(recentEligible("approve_integration", "github_actions:p1")).toBe(false);
    // Owner-chosen grace window covers sensitive routine actions only.
    expect(recentEligible("global_pause", "global_pause:on")).toBe(true);
    expect(recentEligible("autonomy_toggle", "dev:p1")).toBe(true);
    expect(recentEligible("credential_change", "github_app:manifest")).toBe(true);
    expect(recentEligible("owner_settings", "x")).toBe(true);
    expect(recentEligible("merge_update", "x")).toBe(false);
    expect(recentEligible("privilege_escalation", "x")).toBe(false);
  });
  it("expires after 10 minutes and needs a still-registered key", () => {
    const now = Date.now();
    const at = (ms: number) => ({ created_at: new Date(now - ms).toISOString() });
    expect(recentVerificationValid(at(60_000), true, now)).toBe(true);
    expect(recentVerificationValid(at(RECENT_VERIFICATION_MS + 1), true, now)).toBe(false);
    expect(recentVerificationValid(at(60_000), false, now)).toBe(false);
    expect(recentVerificationValid({ ...at(60_000), recent: true }, true, now)).toBe(false);
    expect(recentVerificationValid(null, true, now)).toBe(false);
  });
});

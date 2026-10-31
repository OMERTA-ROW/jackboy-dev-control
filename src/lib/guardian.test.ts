import { describe, expect, it } from "vitest";
import { guardianCheck, type GuardianInput } from "./guardian";

const base: GuardianInput = {
  agent: { category: "angeltech", autonomy: "experiment", paused: false, installedVerified: true, passportApproved: true, projectId: "p1" },
  action: "propose", targetProjectId: "p1", globalPaused: false,
  integrations: { sandbox: true, search: true, omni: true, repo: true },
};

describe("Guardian", () => {
  it("allows in-scope autonomous work", () => expect(guardianCheck(base).allow).toBe(true));
  it("denies when an integration is missing", () => expect(guardianCheck({ ...base, action: "experiment", integrations: {} }).allow).toBe(false));
  it("enforces project isolation", () => expect(guardianCheck({ ...base, targetProjectId: "p2" }).allow).toBe(false));
  it("emergency and per-agent pause block everything", () => {
    expect(guardianCheck({ ...base, globalPaused: true }).allow).toBe(false);
    expect(guardianCheck({ ...base, agent: { ...base.agent, paused: true } }).allow).toBe(false);
  });
  it("unapproved passports can't act", () => expect(guardianCheck({ ...base, agent: { ...base.agent, passportApproved: false } }).allow).toBe(false));
  it("unverified agents can't act", () => expect(guardianCheck({ ...base, agent: { ...base.agent, installedVerified: false } }).allow).toBe(false));
  it("high-impact actions need the owner", () => {
    for (const a of ["deploy_production", "transfer_private_data", "change_credentials", "publish_external", "high_impact"] as const) {
      const v = guardianCheck({ ...base, action: a });
      expect(v.allow).toBe(false);
      expect(v.needsOwner).toBe(true);
      expect(guardianCheck({ ...base, action: a, ownerApproved: true }).allow).toBe(true);
    }
  });
  it("autonomy tiers limit scope", () => {
    expect(guardianCheck({ ...base, agent: { ...base.agent, autonomy: "observe" } }).allow).toBe(false);
    expect(guardianCheck({ ...base, agent: { ...base.agent, autonomy: "observe" }, action: "discover" }).allow).toBe(true);
  });
  it("adversarial tests are DemonTech only", () => {
    expect(guardianCheck({ ...base, action: "adversarial_test" }).allow).toBe(false);
    expect(guardianCheck({ ...base, action: "adversarial_test", agent: { ...base.agent, category: "demontech" } }).allow).toBe(true);
  });
});

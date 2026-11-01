import { describe, expect, it } from "vitest";
import { canDecide, classifyTier, coveredByTask } from "./action-approval";

const req = (o = {}) => ({ status: "pending", expires_at: new Date(Date.now() + 60_000).toISOString(), tier: "controlled" as const, requested_by: "u", ...o });
describe("action approval cards", () => {
  it("classifies tiers", () => {
    expect(classifyTier("read_checks", "low")).toBe("routine");
    expect(classifyTier("open_draft_pr", "low")).toBe("controlled");
    expect(classifyTier("open_draft_pr", "sensitive")).toBe("critical");
    expect(classifyTier("production_deploy", "low")).toBe("critical");
  });
  it("approval: a pending controlled request can be allowed", () => expect(canDecide(req(), "u", "allow_once", false)).toBeNull());
  it("expiry: expired requests cannot be decided", () => expect(canDecide(req({ expires_at: new Date(Date.now() - 1).toISOString() }), "u", "allow_once", false)).toMatch(/expired/));
  it("deny is always possible while pending", () => expect(canDecide(req({ tier: "critical" }), "u", "deny", false)).toBeNull());
  it("duplicate: a decided request cannot be decided again", () => expect(canDecide(req({ status: "allowed" }), "u", "allow_once", false)).toMatch(/Already/));
  it("other users cannot decide", () => expect(canDecide(req(), "x", "allow_once", false)).toMatch(/another/));
  it("critical needs a passkey and only once", () => {
    expect(canDecide(req({ tier: "critical" }), "u", "allow_once", false)).toMatch(/passkey/);
    expect(canDecide(req({ tier: "critical" }), "u", "allow_task", true)).toMatch(/once/);
    expect(canDecide(req({ tier: "critical" }), "u", "allow_once", true)).toBeNull();
  });
  it("allow for task covers later non-critical actions on that task only", () => {
    const prior = [{ task_id: "t", mode: "task", status: "allowed", tier: "controlled" as const }];
    expect(coveredByTask(prior, "t", "routine")).toBe(true);
    expect(coveredByTask(prior, "t2", "routine")).toBe(false);
    expect(coveredByTask(prior, "t", "critical")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { canDispatch, matchPlaybooks, routeApproval, type Change, type Policy } from "./automation-policy";

const p: Policy = { tier: 1, paused: false, guardianVerified: true, maxFiles: 3, maxLines: 50 };
const c: Change = { action: "merge", categories: ["docs"], filesChanged: 1, linesChanged: 10, testsPassed: true, branchProtected: true, rollbackPlan: true, guardianVerdict: "pass" };

describe("automation policy", () => {
  it("tier 0 sends everything to the owner", () => expect(routeApproval(c, { ...p, tier: 0 }).route).toBe("owner"));
  it("tier 1 lets Guardian approve a tiny verified low-risk merge", () => expect(routeApproval(c, p).route).toBe("guardian"));
  it("high-risk areas always need the owner", () => {
    for (const cat of ["auth", "security", "payment", "data", "production"]) expect(routeApproval({ ...c, categories: [cat] }, { ...p, tier: 2 }).route).toBe("owner");
  });
  it("production deploys always need the owner", () => expect(routeApproval({ ...c, action: "deploy_production" }, { ...p, tier: 2 }).route).toBe("owner"));
  it("requires tests, branch protection, rollback, Guardian pass and verified Guardian", () => {
    expect(routeApproval({ ...c, testsPassed: false }, p).route).toBe("owner");
    expect(routeApproval({ ...c, branchProtected: false }, p).route).toBe("owner");
    expect(routeApproval({ ...c, rollbackPlan: false }, p).route).toBe("owner");
    expect(routeApproval({ ...c, guardianVerdict: "none" }, p).route).toBe("owner");
    expect(routeApproval(c, { ...p, guardianVerified: false }).route).toBe("owner");
  });
  it("oversized changes need the owner", () => expect(routeApproval({ ...c, linesChanged: 51 }, p).route).toBe("owner"));
  it("staging deploys need tier 2", () => {
    expect(routeApproval({ ...c, action: "deploy_staging" }, p).route).toBe("owner");
    expect(routeApproval({ ...c, action: "deploy_staging" }, { ...p, tier: 2 }).route).toBe("guardian");
  });
  it("pause blocks everything", () => {
    expect(routeApproval(c, { ...p, paused: true }).route).toBe("blocked");
    expect(canDispatch({ paused: true }, true).ok).toBe(false);
    expect(canDispatch({ paused: false }, false).ok).toBe(false);
  });
  it("retrieval uses verified playbooks only", () => {
    const r = matchPlaybooks([{ title: "Fix flaky test", trigger: "flaky timeout", verified: false }, { title: "Bump dependency", trigger: "dependency audit", verified: true }], "flaky dependency");
    expect(r.map((x) => x.title)).toEqual(["Bump dependency"]);
  });
});

import { describe, expect, it } from "vitest";
import { agentProjectAnchor, agentProjectHref, canPerform, hashProjectToken, isWellFormedProjectToken, newProjectToken, priorityScore, requiresOwnerApproval, reuseVerdict, validateIngest } from "./agent-hub";

const base = { severity: "high", title: "Leaked key in repo", detail: "" };

describe("agent hub rules", () => {
  it("routes project blockers to the matching Agent Hub project card", () => {
    const projectId = "22222222-2222-4222-8222-222222222222";
    expect(agentProjectHref(projectId)).toBe(`/agents#${agentProjectAnchor(projectId)}`);
    expect(agentProjectAnchor(projectId)).toBe(`agent-project-${projectId}`);
    expect(agentProjectHref("a/b")).toBe("/agents#agent-project-a%2Fb");
  });

  it("DemonTech may only submit defensive checks", () => {
    expect(validateIngest({ ...base, agent: "demontech", kind: "secret_scan" }).ok).toBe(true);
    expect(validateIngest({ ...base, agent: "demontech", kind: "exploit" }).ok).toBe(false);
    expect(validateIngest({ ...base, agent: "demontech", kind: "diagnostic" }).ok).toBe(false);
  });
  it("AngelTech limited to diagnostics/research/code quality", () => {
    expect(validateIngest({ ...base, agent: "angeltech", kind: "code_quality" }).ok).toBe(true);
    expect(validateIngest({ ...base, agent: "angeltech", kind: "secret_scan" }).ok).toBe(false);
  });
  it("prioritises severity and security", () => {
    expect(priorityScore("critical", "demontech")).toBe(100);
    expect(priorityScore("medium", "angeltech")).toBe(30);
    expect(priorityScore("low", "angeltech", 30)).toBe(20);
  });
  it("blocks copying without license + attribution", () => {
    expect(reuseVerdict("MIT", "octo/lib")).toBe("reference_with_attribution");
    expect(reuseVerdict("MIT", "")).toBe("do_not_copy");
    expect(reuseVerdict("GPL-3.0", "x")).toBe("owner_review_required");
    expect(reuseVerdict(null, "x")).toBe("do_not_copy");
    expect(reuseVerdict("Proprietary", "x")).toBe("do_not_copy");
  });
  it("merge, production deploy and sensitive changes need owner approval", () => {
    expect(requiresOwnerApproval("open_pr")).toBe(false);
    expect(requiresOwnerApproval("merge")).toBe(true);
    expect(requiresOwnerApproval("deploy_production")).toBe(true);
    expect(requiresOwnerApproval("sensitive_change")).toBe(true);
    expect(canPerform("merge", { status: "proposed", testsPassed: true, approvedByOwner: false })).toBe(false);
    expect(canPerform("merge", { status: "approved", testsPassed: false, approvedByOwner: true })).toBe(false);
    expect(canPerform("merge", { status: "approved", testsPassed: true, approvedByOwner: true })).toBe(true);
  });
  it("tokens are well-formed and hashed", async () => {
    const t = newProjectToken();
    expect(isWellFormedProjectToken(t)).toBe(true);
    expect(await hashProjectToken(t)).toHaveLength(64);
    expect(await hashProjectToken(t)).not.toContain(t.slice(4));
  });
});

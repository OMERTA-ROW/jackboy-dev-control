import { describe, expect, it } from "vitest";
import { workflowPinReport, workflowStateProblem } from "./code-workflow-readiness";

describe("CODE workflow on/off state in GitHub", () => {
  it("only an active workflow is runnable", () => {
    expect(workflowStateProblem("active")).toBeNull();
    expect(workflowStateProblem("disabled_manually")).toContain("Enable workflow");
    expect(workflowStateProblem("disabled_inactivity")).toContain("disabled_inactivity");
    expect(workflowStateProblem(null)).toContain("treated as off");
  });
});

const repo = "OMERTA-ROW/jackboy-dev-control";
const old = "82c0c44e9afeacb45e666ff131e34b90ae2da23b";
const merged = "ebc71c1923c3d6ab925ec6b9e4fa971e311f3761";
const targets = (workflowSha: string) => ({ [repo]: { ref: "main", workflowSha } });
describe("post-merge workflow pin evidence", () => {
  it("reports matching old copies as stale against the merged workflow without modifying them", () => {
    const stored = targets(old);
    const report = workflowPinReport(stored, JSON.stringify(stored), merged);
    expect(report.matches).toBe(false);
    expect(report.proposedTargets).toEqual(targets(merged));
    expect(stored).toEqual(targets(old));
  });
  it("passes only the same single Jackboy main workflow in all three sources", () => {
    expect(workflowPinReport(targets(merged), JSON.stringify(targets(merged)), merged).matches).toBe(true);
    expect(workflowPinReport(targets(old), JSON.stringify(targets(merged)), merged).matches).toBe(false);
    expect(workflowPinReport(targets(merged), JSON.stringify({ ...targets(merged), "OMERTA-ROW/Omni": { ref: "main", workflowSha: merged } }), merged).matches).toBe(false);
  });
  it("fails closed on absent policy, unavailable GitHub evidence or a non-main ref", () => {
    expect(workflowPinReport(targets(merged), undefined, merged).matches).toBe(false);
    expect(workflowPinReport(targets(merged), JSON.stringify(targets(merged)), null).proposedTargets).toBeNull();
    expect(workflowPinReport(targets(merged), JSON.stringify({ [repo]: { ref: "dev", workflowSha: merged } }), merged).matches).toBe(false);
  });
});
import { describe, expect, it } from "vitest";
import { qualityMetrics } from "./quality-metrics";

const empty = { tasks: [], proposals: [], releases: [], installs: [] };
describe("quality metrics", () => {
  it("no data is reported as unknown, not 0%", () => {
    const m = qualityMetrics(empty);
    expect(m.repairSuccess.value).toBeNull(); expect(m.rollback.value).toBeNull();
  });
  it("repair success counts completed against all finished tasks", () =>
    expect(qualityMetrics({ ...empty, tasks: [{ state: "completed", test_evidence: {} }, { state: "failed", test_evidence: {} }, { state: "testing", test_evidence: {} }] }).repairSuccess).toMatchObject({ value: 50, num: 1, den: 2 }));
  it("tests that could not run are excluded from the failure rate", () => {
    const m = qualityMetrics({ ...empty, tasks: [{ state: "completed", test_evidence: { status: "not_runnable" } }] });
    expect(m.testFailure.value).toBeNull(); expect(m.testsNotRunnable).toBe(1);
  });
  it("regression = merged then reverted", () =>
    expect(qualityMetrics({ ...empty, proposals: [{ status: "merged", checks_state: null, revert_pr_url: null }, { status: "reverted", checks_state: null, revert_pr_url: "x" }] }).regression.value).toBe(50));
  it("rollback and failed install rates", () => {
    const m = qualityMetrics({ ...empty, releases: [{ status: "rolled_back" }, { status: "rolling" }, { status: "rolling" }, { status: "rolling" }], installs: [{ phase: "failed" }, { phase: "healthy" }, { phase: "downloaded" }] });
    expect(m.rollback.value).toBe(25); expect(m.failedDeployment.value).toBe(50);
  });
});

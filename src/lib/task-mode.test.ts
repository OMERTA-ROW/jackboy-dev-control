import { describe, expect, it } from "vitest";
import {
  canMove, canSkip, checkDraft, MAX_FAILURES, MAX_STEPS, needsCheckpoint, NEVER_SKIP, nextMove, skipRuleTarget, stepFingerprint,
  stepTarget, stepTypeFor, TASK_TOOLS, type StepRow,
} from "./task-mode";
import { FRESH_ONLY_ACTIONS, recentEligible } from "./step-up";

const P = "11111111-1111-4111-8111-111111111111";
const step = (position: number, step_type: string, status = "pending", project_id: string | null = P): StepRow => ({ id: `s${position}`, position, step_type, project_id, status });
const running = { status: "running" as const, failures: 0, expires_at: new Date(Date.now() + 60_000).toISOString() };
const ctx = { paused: false, rules: {} };

describe("Task Mode checkpoints", () => {
  it("read steps run without approval; anything that changes a project stops for the passkey", () => {
    expect(needsCheckpoint("read", P, {})).toBe(false);
    for (const t of ["scan_site", "inspect_code", "save_draft", "open_draft_pr"]) expect(needsCheckpoint(t, P, {})).toBe(true);
  });
  it("the five never-skip types always stop, even if a rule lists them", () => {
    expect(NEVER_SKIP).toEqual(["pay", "delete", "publish", "credentials", "send"]);
    for (const t of NEVER_SKIP) { expect(needsCheckpoint(t, P, { [t]: [P] })).toBe(true); expect(canSkip(t)).toBe(false); }
  });
  it("an unknown step type means checkpoint", () => {
    expect(needsCheckpoint("click_mystery_button", P, { click_mystery_button: [P] })).toBe(true);
  });
  it("a skip rule applies only to the projects you chose", () => {
    expect(needsCheckpoint("scan_site", P, { scan_site: [P] })).toBe(false);
    expect(needsCheckpoint("scan_site", "22222222-2222-4222-8222-222222222222", { scan_site: [P] })).toBe(true);
    expect(needsCheckpoint("scan_site", null, { scan_site: [P] })).toBe(true);
    expect(canSkip("open_draft_pr")).toBe(false);
  });
});

describe("step types are decided before anything runs", () => {
  it("writeFile with no content is a delete, not a draft", () => {
    expect(stepTypeFor("writeFile", { content: "x" })).toBe("save_draft");
    expect(stepTypeFor("writeFile", { content: null })).toBe("delete");
  });
  it("Autopilot, background work, repo links, Foundry approvals and auto-fix are not task actions", () => {
    for (const t of ["setAutopilot", "setDevEnabled", "linkRepo", "foundryDecide", "fixIssue"]) { expect(TASK_TOOLS[t]).toBeUndefined(); expect(stepTypeFor(t, {})).toBeNull(); }
  });
  it("drafts are refused when empty, too long or using other actions", () => {
    expect(checkDraft([])).not.toHaveLength(0);
    expect(checkDraft(Array.from({ length: MAX_STEPS + 1 }, () => ({ tool: "capabilities", args: {}, why: "" })))).not.toHaveLength(0);
    expect(checkDraft([{ tool: "setAutopilot", args: {}, why: "" }])[0]).toMatch(/isn't something Task Mode can do/);
    expect(checkDraft([{ tool: "capabilities", args: {}, why: "" }])).toEqual([]);
  });
});

describe("runner order and stops", () => {
  it("runs steps in order and stops at the first checkpoint", () => {
    const steps = [step(2, "scan_site"), step(1, "read", "done"), step(3, "read")];
    expect(nextMove(running, steps, ctx)).toEqual({ kind: "checkpoint", step: steps[0] });
  });
  it("an approved step runs; a waiting step never runs", () => {
    expect(nextMove(running, [step(1, "scan_site", "approved")], ctx).kind).toBe("run");
    expect(nextMove(running, [step(1, "scan_site", "waiting")], ctx).kind).toBe("wait");
  });
  it("Kill Switch stops the task at its next step", () => {
    expect(nextMove(running, [step(1, "read")], { ...ctx, paused: true })).toEqual({ kind: "stop", reason: expect.stringMatching(/Kill Switch/) });
  });
  it("time limit stops the task", () => {
    expect(nextMove({ ...running, expires_at: new Date(Date.now() - 1).toISOString() }, [step(1, "read")], ctx).kind).toBe("stop");
  });
  it("two failures stop the task", () => {
    expect(MAX_FAILURES).toBe(2);
    expect(nextMove({ ...running, failures: 2 }, [step(1, "read", "failed")], ctx).kind).toBe("fail");
    expect(nextMove({ ...running, failures: 1 }, [step(1, "read", "failed")], ctx).kind).toBe("run");
  });
  it("a failed approval step needs a new passkey before it re-runs", () => {
    expect(nextMove({ ...running, failures: 1 }, [step(1, "save_draft", "failed")], ctx).kind).toBe("checkpoint");
  });
  it("finishes when every step is done, and only a running task moves", () => {
    expect(nextMove(running, [step(1, "read", "done")], ctx).kind).toBe("done");
    for (const s of ["draft", "waiting", "done", "failed", "stopped"] as const) expect(nextMove({ ...running, status: s }, [step(1, "read")], ctx).kind).toBe("wait");
  });
  it("done is final; failed and stopped can only resume", () => {
    expect(canMove("done", "running")).toBe(false);
    expect(canMove("failed", "running")).toBe(true);
    expect(canMove("draft", "done")).toBe(false);
  });
});

describe("passkey binding", () => {
  it("each approval is bound to one step and its exact action and input", async () => {
    const a = await stepFingerprint("scanSite", { project: "Hercules" });
    expect(a).toBe(await stepFingerprint("scanSite", { project: "Hercules" }));
    expect(a).not.toBe(await stepFingerprint("scanSite", { project: "OMNI" }));
    expect(await stepFingerprint("x", { a: 1, b: 2 })).toBe(await stepFingerprint("x", { b: 2, a: 1 }));
    expect(stepTarget("s1", a)).not.toBe(stepTarget("s2", a));
    expect(stepTarget("00000000-0000-4000-8000-000000000000", a).length).toBeLessThanOrEqual(200);
  });
  it("skip-rule changes are bound to the exact project set", async () => {
    expect(await skipRuleTarget("scan_site", ["b", "a"])).toBe(await skipRuleTarget("scan_site", ["a", "b"]));
    expect(await skipRuleTarget("scan_site", ["a"])).not.toBe(await skipRuleTarget("scan_site", ["a", "b"]));
  });
  it("task approvals and skip-rule changes always need a new passkey tap", () => {
    for (const a of ["task_step", "task_skip_rule"]) { expect(FRESH_ONLY_ACTIONS).toContain(a); expect(recentEligible(a, "x")).toBe(false); }
  });
});

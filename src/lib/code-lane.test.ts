import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  AUTO_MAX_FILES, AUTO_MAX_LINES, AUTO_RUNS_PER_SITE_PER_DAY, autoEnvProblems, autoLaneTarget, chooseLane, classifyPatch,
  expectedEnvironment, expectedSubject, laneOf, protectedPath, trialLane, type RequestFacts,
} from "./code-lane";
import { FRESH_ONLY_ACTIONS, recentEligible } from "./step-up";
import { checkWorkflowContent } from "./guidelines";

const facts = (o: Partial<RequestFacts> = {}): RequestFacts => ({
  instruction: "Fix the footer spacing on the home page", siteAutoEnabled: true, killSwitch: false, failureStop: false,
  autoRunsToday: 0, holdUsd: 1, spendBlocked: null, ...o,
});
const file = (path: string, additions = 2, deletions = 1, status = "modified") => ({ path, status, additions, deletions });

describe("lane is decided by the server, before the run", () => {
  it("only the exact stored value \"auto\" means automatic", () => {
    expect(laneOf({ lane: "auto" })).toBe("auto");
    for (const v of ["AUTO", "reviewed", true, 1, null, undefined]) expect(laneOf({ lane: v })).toBe("reviewed");
    expect(laneOf(null)).toBe("reviewed");
  });
  it("the reviewed lane keeps today's environments; the automatic lane uses the new ones", () => {
    expect(expectedEnvironment("execute", "reviewed")).toBe("CODE");
    expect(expectedEnvironment("publish", "reviewed")).toBe("CODE-PUBLISH");
    expect(expectedEnvironment("execute", "auto")).toBe("CODE-AUTO");
    expect(expectedEnvironment("publish", "auto")).toBe("CODE-PUBLISH-AUTO");
    expect(expectedEnvironment("finish", "auto")).toBeUndefined();
    expect(expectedSubject("o/r", "execute", "reviewed", "main")).toBe("repo:o/r:environment:CODE");
    expect(expectedSubject("o/r", "finish", "auto", "main")).toBe("repo:o/r:ref:refs/heads/main");
  });
});

describe("low-risk request rules", () => {
  it("a small, plain fix on an enabled site gets the automatic lane", () => {
    expect(chooseLane(facts())).toEqual({ lane: "auto", reasons: [] });
  });
  it("every condition must hold", () => {
    expect(chooseLane(facts({ siteAutoEnabled: false })).lane).toBe("reviewed");
    expect(chooseLane(facts({ killSwitch: true })).lane).toBe("reviewed");
    expect(chooseLane(facts({ failureStop: true })).lane).toBe("reviewed");
    expect(chooseLane(facts({ autoRunsToday: AUTO_RUNS_PER_SITE_PER_DAY })).lane).toBe("reviewed");
    expect(chooseLane(facts({ holdUsd: 1.01 })).lane).toBe("reviewed");
    expect(chooseLane(facts({ spendBlocked: "Daily limit reached." })).lane).toBe("reviewed");
  });
  it("risky words always mean review", () => {
    for (const w of ["Add a database migration", "Rotate the API key", "Fix the login page", "Deploy the site", "Merge the PR", "Update the workflow", "Upgrade dependencies", "Delete old pages", "Change payment copy"])
      expect(chooseLane(facts({ instruction: w })).lane, w).toBe("reviewed");
  });
  it("the daily cap is 3 automatic runs per site", () => {
    expect(AUTO_RUNS_PER_SITE_PER_DAY).toBe(3);
    expect(chooseLane(facts({ autoRunsToday: 2 })).lane).toBe("auto");
  });
  it("trial labels ignore the site switch but nothing else", () => {
    expect(trialLane(facts({ siteAutoEnabled: false })).wouldAuto).toBe(true);
    expect(trialLane(facts({ siteAutoEnabled: false, killSwitch: true })).wouldAuto).toBe(false);
  });
});

describe("the actual patch is re-checked", () => {
  it("small edits to ordinary files pass", () => {
    expect(classifyPatch({ fileCount: 2, files: [file("src/components/Footer.tsx"), file("src/routes/about.tsx", 10, 5, "added")] }).lowRisk).toBe(true);
  });
  it(`at most ${AUTO_MAX_FILES} files and ${AUTO_MAX_LINES} lines`, () => {
    expect(classifyPatch({ fileCount: 4, files: [file("a.ts"), file("b.ts"), file("c.ts"), file("d.ts")] }).lowRisk).toBe(false);
    expect(classifyPatch({ fileCount: 1, files: [file("a.ts", 40, 11)] }).lowRisk).toBe(false);
    expect(classifyPatch({ fileCount: 1, files: [file("a.ts", 40, 10)] }).lowRisk).toBe(true);
  });
  it("deleted, renamed or binary files need review", () => {
    for (const st of ["removed", "renamed", "binary", ""]) expect(classifyPatch({ fileCount: 1, files: [file("a.ts", 1, 0, st)] }).lowRisk).toBe(false);
  });
  it("protected paths always need review", () => {
    for (const p of [".github/workflows/code.yml", "supabase/migrations/1.sql", "drizzle/migrations/0050.sql", ".env", ".env.local", "package.json", "bun.lockb", "go.sum",
      "src/lib/auth.ts", "src/lib/passkey.server.ts", "src/lib/step-up.ts", "src/routes/_authenticated/billing.tsx", "src/lib/stripe.ts", "src/lib/code-safety.ts", "src/lib/code-lane.ts",
      "scripts/code-patch.mjs", "src/integrations/supabase/client.ts", "src/lib/secret-store.ts", "wrangler.jsonc"])
      expect(protectedPath(p), p).toBe(true);
    expect(protectedPath("src/components/Footer.tsx")).toBe(false);
  });
  it("missing, empty, incomplete or malformed reports need review", () => {
    expect(classifyPatch(null).lowRisk).toBe(false);
    expect(classifyPatch({ fileCount: 0, files: [] }).lowRisk).toBe(false);
    expect(classifyPatch({ fileCount: 9, files: [file("a.ts")] }).lowRisk).toBe(false);
    expect(classifyPatch({ fileCount: 1, files: [file("../etc/passwd")] }).lowRisk).toBe(false);
    expect(classifyPatch({ fileCount: 1, files: [{ path: "a.ts", status: "modified", additions: -1, deletions: 0 }] }).lowRisk).toBe(false);
  });
});

describe("automatic GitHub environments (read-only check)", () => {
  const env = { protection_rules: [], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
  it("ready when main-only with no secrets, variables or reviewers", () => {
    expect(autoEnvProblems(env, ["main"], 0, 0)).toEqual([]);
  });
  it("flags missing, all-branches, extra branches, secrets, variables and unreadable parts", () => {
    expect(autoEnvProblems(null, null, null, null)).toEqual(["Not created yet."]);
    expect(autoEnvProblems({ ...env, deployment_branch_policy: null }, null, 0, 0)).toHaveLength(1);
    expect(autoEnvProblems(env, ["main", "dev"], 0, 0)).toHaveLength(1);
    expect(autoEnvProblems(env, ["main"], 1, 0)[0]).toMatch(/secret/);
    expect(autoEnvProblems(env, ["main"], 0, 2)[0]).toMatch(/variable/);
    expect(autoEnvProblems(env, ["main"], null, 0)[0]).toMatch(/Couldn't read/);
  });
});

describe("switch and staged workflow", () => {
  it("the per-site switch always needs a new passkey tap, bound to one site and one direction", () => {
    expect(FRESH_ONLY_ACTIONS).toContain("code_auto_lane");
    expect(recentEligible("code_auto_lane", autoLaneTarget("o/r", true))).toBe(false);
    expect(autoLaneTarget("o/r", true)).not.toBe(autoLaneTarget("o/r", false));
    expect(autoLaneTarget("o/r", true)).not.toBe(autoLaneTarget("o/x", true));
  });
  it("the staged lane workflow keeps draft-only PRs, both reviewed environments, and reports the patch to the server", () => {
    const y = readFileSync("staging/code-lane/code.yml", "utf8");
    expect(y).toContain("inputs.lane == 'auto' && 'CODE-AUTO' || 'CODE'");
    expect(y).toContain("inputs.lane == 'auto' && 'CODE-PUBLISH-AUTO' || 'CODE-PUBLISH'");
    expect(y).toContain("--draft");
    expect(y).toContain("patch: JSON.parse(process.env.CODE_PATCH_REPORT");
    expect(y).not.toMatch(/gh pr merge|pull_request_target|secrets\./);
    expect(checkWorkflowContent(y)).toBeNull();
  });
});

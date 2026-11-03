import { describe, expect, it } from "vitest";
import { checkWorkflowContent, GUIDELINES } from "./guidelines";
import { checkWorkBranch } from "./repo-workspace";
import { canExecute } from "./foundry";
describe("autonomous guidelines", () => {
  it("has eight rules", () => expect(GUIDELINES).toHaveLength(8));
  it("refuses protected branches", () => { expect(checkWorkBranch("main", "dev")).toBeTruthy(); expect(checkWorkBranch("jackboy/fix-nav", "main")).toBeNull(); });
  it("stops after two failures", () => expect(canExecute({ state: "approved", approved_action: "open_draft_pr", paused: false, attempts: 2, max_attempts: 5 })).toMatch(/twice/));
  it("allows first retry", () => expect(canExecute({ state: "approved", approved_action: "open_draft_pr", paused: false, attempts: 1, max_attempts: 5 })).toBeNull());
  it("blocks unsafe workflows", () => { expect(checkWorkflowContent("on: pull_request_target")).toBeTruthy(); expect(checkWorkflowContent("run: echo ${{ secrets.X }}")).toBeTruthy(); expect(checkWorkflowContent("on: push\njobs: {}")).toBeNull(); });
});

import { describe, expect, it } from "vitest";
import { codeTargetRefusal } from "./code-safety";

const allowedRepo = "OMERTA-ROW/jackboy-dev-control";
const sha = "37368194f883bc1cf5175aecf4832945203b602b";
const allowed = { [allowedRepo]: { ref: "main", workflowSha: sha } };

describe("codeTargetRefusal", () => {
  it("lets the one approved repository through", () => {
    expect(codeTargetRefusal(allowedRepo, allowed)).toBeNull();
  });
  it("names the refused repository and the allowed one", () => {
    const msg = codeTargetRefusal("OMERTA-ROW/Omni", allowed);
    expect(msg).toContain("OMERTA-ROW/Omni");
    expect(msg).toContain(allowedRepo);
    expect(msg).not.toMatch(/runner ref and workflow blob SHA/);
  });
  it("says nothing is allowed when the list is empty (missing or mismatched CODE_TARGETS)", () => {
    const msg = codeTargetRefusal(allowedRepo, {});
    expect(msg).toContain(allowedRepo);
    expect(msg).toContain("no repository is currently allowed");
  });
  it("still refuses a listed repository with an invalid pin", () => {
    expect(codeTargetRefusal(allowedRepo, { [allowedRepo]: { ref: "main", workflowSha: "bad" } })).toContain("invalid");
  });
  it("does not treat inherited object keys as allowed", () => {
    expect(codeTargetRefusal("constructor", allowed)).not.toBeNull();
  });
});

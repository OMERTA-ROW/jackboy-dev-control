import { describe, expect, it } from "vitest";
import { CODE_RUNNER_REPO, orgTargetRefusal } from "./code-org-scope";

const ok = (name: string) => ({ fullName: name, archived: false, defaultBranch: "main" });
const none = new Set<string>();

describe("org-wide CODE scope", () => {
  it("allows a new, never-listed OMERTA-ROW repository", () => {
    expect(orgTargetRefusal("OMERTA-ROW/brand-new-repo", ok("OMERTA-ROW/brand-new-repo"), none)).toBeNull();
  });
  it("refuses any other owner", () => {
    expect(orgTargetRefusal("someone-else/orbiting-minds-mothership", ok("someone-else/orbiting-minds-mothership"), none)).toMatch(/only OMERTA-ROW/);
    expect(orgTargetRefusal("omerta-row-evil/x", ok("omerta-row-evil/x"), none)).toMatch(/only OMERTA-ROW/);
  });
  it("refuses a blocked repository", () => {
    const r = "OMERTA-ROW/orbiting-minds-mothership";
    expect(orgTargetRefusal(r, ok(r), new Set([r]))).toMatch(/blocked/);
  });
  it("refuses archived, non-main and unreadable repositories", () => {
    const r = "OMERTA-ROW/x";
    expect(orgTargetRefusal(r, { ...ok(r), archived: true }, none)).toMatch(/archived/);
    expect(orgTargetRefusal(r, { ...ok(r), defaultBranch: "master" }, none)).toMatch(/main/);
    expect(orgTargetRefusal(r, null, none)).toMatch(/couldn't read/);
  });
  it("refuses a renamed/transferred repository", () => {
    expect(orgTargetRefusal("OMERTA-ROW/x", ok("other/x"), none)).toMatch(/different/);
  });
  it("Jackboy itself keeps its direct pin", () => {
    expect(orgTargetRefusal(CODE_RUNNER_REPO, null, none)).toBeNull();
  });
});

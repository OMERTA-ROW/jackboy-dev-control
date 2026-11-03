import { expect, it } from "vitest";
import { declaredPermission, obsoleteGithubBlock, type GithubPermissionEvidence } from "./project-permissions";
it("does not claim PR or Actions write from readable token endpoints", () => { expect(declaredPermission(undefined, "Pull requests", "OMERTA-ROW/Omni").state).toBe("unknown"); expect(declaredPermission("read", "Actions", "OMERTA-ROW/Omni").state).toBe("denied"); });
it("clears only obsolete PR errors after a live repo and write grant check", () => {
  const e = { exists: true, contentsRead: { state: "verified" }, pullRequestsWrite: { state: "verified" } } as GithubPermissionEvidence;
  expect(obsoleteGithubBlock("Draft PR refused: token lacks Pull requests: write.", e)).toBe(true);
  expect(obsoleteGithubBlock("Sensitive finding — owner review required.", e)).toBe(false);
  expect(obsoleteGithubBlock("Draft PR refused", { ...e, exists: false })).toBe(false);
});
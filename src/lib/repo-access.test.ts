import { describe, it, expect } from "vitest";
import { assessRepoAccess } from "./repo-workspace";
describe("assessRepoAccess", () => {
  it("allows a public org repo when the account has push", () => {
    const a = assessRepoAccess({ private: false, owner: { login: "OMERTA-ROW", type: "Organization" }, permissions: { pull: true, push: true } });
    expect(a).toMatchObject({ canRead: true, canWrite: true, visibility: "public", org: "OMERTA-ROW", reason: null });
  });
  it("public visibility alone never grants write", () => {
    const a = assessRepoAccess({ private: false, permissions: { pull: true, push: false } });
    expect(a.canWrite).toBe(false);
  });
  it("no permissions object means no access", () => {
    expect(assessRepoAccess({ private: false }).canRead).toBe(false);
  });
  it("archived repos are read-only", () => {
    expect(assessRepoAccess({ private: true, archived: true, permissions: { pull: true, push: true } }).canWrite).toBe(false);
  });
});

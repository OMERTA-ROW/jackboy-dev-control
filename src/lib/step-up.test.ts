import { describe, expect, it } from "vitest";
import { grantUsable, mayRequest } from "./step-up";

const g = { user_id: "u", action: "merge_update", target: "p1", expires_at: new Date(Date.now() + 60_000).toISOString(), used_at: null };
describe("passkey step-up", () => {
  it("owner may request a merge step-up", () => expect(mayRequest("merge_update", "owner").ok).toBe(true));
  it("admins and members may not, even with a passkey", () => {
    expect(mayRequest("merge_update", "admin").ok).toBe(false);
    expect(mayRequest("merge_update", "member").ok).toBe(false);
  });
  it("unbuilt actions stay blocked for the owner", () => {
    expect(mayRequest("production_deploy", "owner").ok).toBe(false);
    expect(mayRequest("building_control", "owner").ok).toBe(false);
  });
  it("a grant works only for its exact action and target", () => {
    expect(grantUsable(g, "u", "merge_update", "p1")).toBe(true);
    expect(grantUsable(g, "u", "merge_update", "p2")).toBe(false);
    expect(grantUsable(g, "u", "revert_update", "p1")).toBe(false);
    expect(grantUsable(g, "other", "merge_update", "p1")).toBe(false);
  });
  it("used or expired grants are rejected", () => {
    expect(grantUsable({ ...g, used_at: new Date().toISOString() }, "u", "merge_update", "p1")).toBe(false);
    expect(grantUsable({ ...g, expires_at: new Date(Date.now() - 1).toISOString() }, "u", "merge_update", "p1")).toBe(false);
  });
});

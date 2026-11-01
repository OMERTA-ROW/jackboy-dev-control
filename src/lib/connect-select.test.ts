import { describe, it, expect } from "vitest";
import { connectRows, toggle, selectAll, loopEligible, agentState } from "./connect-select";

const projects = [
  { id: "a", name: "Jackboy", github_repo: "o/jb", connect_state: "repo_linked", connect_error: null },
  { id: "b", name: "Mothership", github_repo: null },
];
const inv = [{ id: "x", name: "jackboy", lovable_project_ref: "r1" }, { id: "y", name: "OMNI", lovable_project_ref: "r2" }];

describe("connect multi-select", () => {
  it("lists every project once with truthful status", () => {
    const r = connectRows(projects, inv);
    expect(r.map((x) => [x.name, x.status])).toEqual([["Jackboy", "repo_linked"], ["Mothership", "connected_no_repo"], ["OMNI", "saved_only"]]);
  });
  it("toggle, select all and clear", () => {
    expect(toggle(["a"], "a")).toEqual([]);
    expect(toggle([], "a")).toEqual(["a"]);
    expect(selectAll(["a"], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
  it("loop runs only with a linked repo; others get the exact fix", () => {
    const [jb, ms, om] = connectRows(projects, inv);
    expect(loopEligible(jb!)).toEqual({ ok: true });
    expect(loopEligible(ms!)).toEqual({ ok: false, reason: "Link a private GitHub repo" });
    expect(loopEligible(om!)).toEqual({ ok: false, reason: "Connect it first" });
  });
  it("agent state comes from real task states", () => {
    expect(agentState(false, []).label).toBe("Offline");
    expect(agentState(true, []).label).toBe("Online");
    expect(agentState(true, [{ state: "testing" }]).label).toBe("Working");
    expect(agentState(true, [{ state: "blocked", blocked_reason: "403" }])).toEqual({ label: "Blocked", reason: "403" });
    expect(agentState(true, [{ state: "awaiting_approval" }]).reason).toBe("Waiting for your approval");
  });
});

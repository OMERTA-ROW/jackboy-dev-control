import { describe, expect, it } from "vitest";
import { approvalTarget, deriveBlockers } from "./blockers";

const P = { id: "p1", name: "Jackboy", github_repo: "o/jackboy", dev_enabled: true, active: true };
const g = (o: Partial<{ capability: string; status: string; paused: boolean; expires_at: string | null; last_error: string | null }>) =>
  ({ capability: "github_actions_read", project_id: "p1", status: "needs_approval", paused: false, expires_at: null, last_error: null, ...o }) as never;

describe("blocker queue", () => {
  it("connected capabilities are not blockers", () => {
    expect(deriveBlockers([P], [g({ status: "connected" })], [])).toEqual([]);
  });
  it("GitHub permission approval requires passkey", () => {
    const b = deriveBlockers([P], [g({})], [])[0]!;
    expect(b.status).toBe("needs_approval");
    expect(b.action).toEqual({ kind: "approve", cap: "github_actions_read", passkey: true });
  });
  it("approved but failing check shows the exact provider error", () => {
    const b = deriveBlockers([P], [g({ status: "error", last_error: "GitHub 403" })], [])[0]!;
    expect(b.cause).toBe("GitHub 403");
    expect(b.action?.kind).toBe("verify");
  });
  it("expired connection becomes a blocker again", () => {
    const b = deriveBlockers([P], [g({ status: "connected", expires_at: "2020-01-01T00:00:00Z" })], [])[0]!;
    expect(b.cause).toBe("Access expired.");
  });
  it("projects that are only in inventory are never treated as connected", () => {
    expect(deriveBlockers([{ ...P, github_repo: null, dev_enabled: false }], [g({})], [])).toEqual([]);
  });
  it("activated project without repo needs a repo link", () => {
    expect(deriveBlockers([{ ...P, github_repo: null }], [], [])[0]!.action).toEqual({ kind: "link_repo" });
  });
  it("unsupported capabilities only show when a task waits on them", () => {
    expect(deriveBlockers([P], [g({ capability: "browser_runner", status: "unavailable" })], [])).toEqual([]);
    const t = { id: "t", project_id: "p1", title: "Run UI test", state: "blocked", needs_capability: "browser_runner", blocked_reason: null };
    expect(deriveBlockers([P], [g({ capability: "browser_runner", status: "unavailable" })], [t])[0]!.status).toBe("unsupported");
  });
  it("passkey target is bound to one capability on one project", () => {
    expect(approvalTarget("github_repo", "p1")).toBe("github_repo:p1");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildIssueBody,
  buildPrBody,
  isPrepWriteAllowed,
  prStatusLine,
  summarizeCi,
  summarizeReviews,
  validatePrBranch,
  validatePrepText,
} from "./github-prep";

const SHA = "a".repeat(40);

describe("GitHub preparation never grants merge or deploy", () => {
  it("only allows creating issues and draft pull requests", () => {
    expect(isPrepWriteAllowed("create_issue")).toBe(true);
    expect(isPrepWriteAllowed("open_draft_pr")).toBe(true);
    for (const a of ["merge", "merge_pr", "deploy", "mark_ready", "approve", "update_branch_protection"])
      expect(isPrepWriteAllowed(a)).toBe(false);
  });

  it("opens pull requests only from jackboy/* branches, never the base", () => {
    expect(validatePrBranch("jackboy/fix-login", "main")).toBeNull();
    expect(validatePrBranch("feature/x", "main")).not.toBeNull();
    expect(validatePrBranch("main", "main")).not.toBeNull();
  });

  it("every prepared body says merging stays with the owner", () => {
    const ci = summarizeCi(SHA, [], []);
    expect(buildIssueBody({ problem: "Login fails", ci, ref: "main", projectName: "OMNI" })).toContain("cannot merge");
    expect(buildPrBody({ summary: "Fix login", ci, branch: "jackboy/x" })).toContain("draft");
  });
});

describe("CI evidence", () => {
  it("reports failed when any check fails", () => {
    const ci = summarizeCi(SHA, [
      { name: "build", status: "completed", conclusion: "success" },
      { name: "test", status: "completed", conclusion: "failure" },
    ], []);
    expect(ci.state).toBe("failed");
    expect(ci.failed).toBe(1);
    expect(ci.passed).toBe(1);
  });

  it("reports running while a check has not completed", () => {
    expect(summarizeCi(SHA, [{ name: "test", status: "in_progress", conclusion: null }], []).state).toBe("running");
  });

  it("reports none when GitHub has no checks", () => {
    expect(summarizeCi(SHA, [], []).state).toBe("none");
  });

  it("uses only the newest commit status per context", () => {
    const ci = summarizeCi(SHA, [], [
      { context: "ci/vercel", state: "success" },
      { context: "ci/vercel", state: "failure" },
    ]);
    expect(ci.state).toBe("passed");
    expect(ci.items).toHaveLength(1);
  });

  it("puts each check with its link into the prepared body", () => {
    const ci = summarizeCi(SHA, [{ name: "test", status: "completed", conclusion: "failure", html_url: "https://github.com/o/r/runs/1" }], []);
    expect(buildIssueBody({ problem: "Tests fail on main", ci, ref: "main", projectName: "OMNI" })).toContain(
      "[test](https://github.com/o/r/runs/1)",
    );
  });
});

describe("review status", () => {
  it("is approved only by an APPROVED review, not comments", () => {
    expect(summarizeReviews([{ user: { login: "a" }, state: "COMMENTED" }], [], []).state).toBe("no_review");
    expect(summarizeReviews([{ user: { login: "a" }, state: "APPROVED" }], [], []).state).toBe("approved");
  });

  it("the latest decision per reviewer wins", () => {
    const r = summarizeReviews(
      [
        { user: { login: "a" }, state: "CHANGES_REQUESTED" },
        { user: { login: "a" }, state: "APPROVED" },
      ],
      [],
      [],
    );
    expect(r.state).toBe("approved");
    expect(r.changesRequested).toEqual([]);
  });

  it("changes requested outranks other approvals", () => {
    const r = summarizeReviews(
      [
        { user: { login: "a" }, state: "APPROVED" },
        { user: { login: "b" }, state: "CHANGES_REQUESTED" },
      ],
      [],
      [],
    );
    expect(r.state).toBe("changes_requested");
  });

  it("is waiting while reviewers are still requested", () => {
    expect(summarizeReviews([], ["owner"], ["core"]).waitingOn).toEqual(["owner", "team core"]);
  });

  it("status line always leaves merging to the owner", () => {
    expect(prStatusLine(summarizeCi(SHA, [], []), summarizeReviews([], [], []), true)).toContain("Merging stays with you");
  });
});

describe("input limits", () => {
  it("needs a real title and description", () => {
    expect(validatePrepText({ title: "Fix", text: "too short" })).not.toBeNull();
    expect(validatePrepText({ title: "Fix the login page", text: "Users cannot sign in on Safari." })).toBeNull();
  });
});

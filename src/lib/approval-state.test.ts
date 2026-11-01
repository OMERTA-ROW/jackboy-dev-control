import { describe, expect, it } from "vitest";
import { bucketOf, groupProposals, optimisticApprove } from "./approval-state";

const draft = (id: string) => ({ id, status: "draft" });
describe("approval state", () => {
  it("approved items are never counted as pending", () => {
    expect(bucketOf({ id: "a", status: "approved" }).bucket).toBe("action_required");
    expect(bucketOf({ id: "a", status: "approved", has_files: true, has_repo: true }).bucket).toBe("in_progress");
  });
  it("approving one of three drops pending from 3 to 2", () => {
    const rows = [draft("1"), draft("2"), draft("3")];
    expect(groupProposals(rows).pending.length).toBe(3);
    expect(groupProposals(optimisticApprove(rows, "1")).pending.length).toBe(2);
  });
  it("approving all three leaves zero pending", () => {
    let rows = [draft("1"), draft("2"), draft("3")];
    for (const id of ["1", "2", "3"]) rows = optimisticApprove(rows, id);
    expect(groupProposals(rows).pending.length).toBe(0);
  });
  it("duplicate approval clicks are harmless", () => {
    const once = optimisticApprove([draft("1")], "1");
    expect(optimisticApprove(once, "1")).toEqual(once);
  });
  it("duplicate rows are counted once", () => expect(groupProposals([draft("1"), draft("1")]).pending.length).toBe(1));
  it("failed delivery shows Action Required, not pending", () =>
    expect(bucketOf({ id: "a", status: "approved", delivery_error: "403", has_files: true, has_repo: true }).bucket).toBe("action_required"));
  it("an open PR with finished checks is a new merge approval", () => expect(bucketOf({ id: "a", status: "pr_open", checks_state: "success" }).bucket).toBe("pending"));
  it("an open PR with running checks is in progress", () => expect(bucketOf({ id: "a", status: "pr_open", checks_state: "pending" }).bucket).toBe("in_progress"));
  it("merged and rejected go to history", () => {
    expect(bucketOf({ id: "a", status: "merged" }).bucket).toBe("history");
    expect(bucketOf({ id: "a", status: "rejected" }).bucket).toBe("history");
  });
});

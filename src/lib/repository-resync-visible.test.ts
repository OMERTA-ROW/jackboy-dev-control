import { describe, it, expect } from "vitest";
import { visibleReviewRows, type RepositoryReviewRow } from "./repository-resync";
const row = (repo: string, group: RepositoryReviewRow["group"], canApply = true): RepositoryReviewRow => ({ repo, proposed: null, group, reason: "", mutable: 1, historical: 0, canApply });
const rows = [row("o/a", "deleted"), row("o/b", "deleted", false), row("o/c", "linked")];
describe("visibleReviewRows", () => {
  it("keeps every row when nothing was confirmed (failure path)", () => { expect(visibleReviewRows(rows, "r1", null)).toHaveLength(3); });
  it("removes confirmed removals for the same review only", () => {
    expect(visibleReviewRows(rows, "r1", { reviewId: "r1", repos: ["o/a"] }).map((r) => r.repo)).toEqual(["o/b", "o/c"]);
  });
  it("ignores confirmations from a different review", () => { expect(visibleReviewRows(rows, "r2", { reviewId: "r1", repos: ["o/a"] })).toHaveLength(3); });
});

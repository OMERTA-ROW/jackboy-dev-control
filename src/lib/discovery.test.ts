import { describe, expect, it } from "vitest";
import { DEMO_FINDINGS, dedupe, rankScore } from "./discovery";

describe("discovery", () => {
  it("removes duplicates by normalised URL or title", () => {
    expect(dedupe(DEMO_FINDINGS).map((f) => f.id)).not.toContain("f4b");
  });
  it("scores all-5s as 100 and weights confidence highest", () => {
    expect(rankScore({ novelty: 5, feasibility: 5, impact: 5, confidence: 5 })).toBe(100);
    expect(rankScore({ novelty: 0, feasibility: 0, impact: 0, confidence: 5 })).toBe(30);
  });
});

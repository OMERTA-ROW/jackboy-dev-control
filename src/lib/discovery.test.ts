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

import { frontierScore, gemReasons, mixTracks, type Finding } from "./discovery";
describe("Never overlook the little guy", () => {
  const f = DEMO_FINDINGS.find((x) => x.id === "f5")! as Finding;
  it("does not lower the frontier score for low visibility", () => {
    expect(frontierScore({ ...f, visibility: "low" })).toBe(frontierScore({ ...f, visibility: "high" }));
  });
  it("flags an independent, low-visibility, high-benefit prototype as an overlooked gem", () => {
    expect(gemReasons(f).length).toBeGreaterThanOrEqual(3);
  });
  it("reserves the configured share of top slots for frontier items", () => {
    const c = Array.from({ length: 6 }, (_, i) => ({ ...f, id: `c${i}`, track: "commercial" as const }));
    const fr = Array.from({ length: 6 }, (_, i) => ({ ...f, id: `f${i}` }));
    const top5 = mixTracks(c, fr, 40).slice(0, 5);
    expect(top5.filter((x) => x.id.startsWith("f")).length).toBe(2);
  });
});

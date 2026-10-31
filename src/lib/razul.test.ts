import { describe, expect, it } from "vitest";
import { findingPriority, normalizeFindings } from "./razul";

const ok = { id: "1", title: "New battery chemistry", evidence: "peer_reviewed", observed_at: "2026-10-01T00:00:00Z", sources: [{ url: "https://arxiv.org/abs/1" }] };

describe("Razul findings", () => {
  it("keeps sourced, timestamped, classified findings", () => expect(normalizeFindings({ findings: [ok] }).findings).toHaveLength(1));
  it("drops findings without sources, timestamp, evidence or with non-http URLs", () => {
    const r = normalizeFindings([{ ...ok, sources: [] }, { ...ok, observed_at: undefined }, { ...ok, evidence: "rumor" }, { ...ok, sources: [{ url: "javascript:alert(1)" }] }]);
    expect(r.findings).toHaveLength(0);
    expect(r.dropped).toBe(4);
  });
  it("ranks verified evidence above confident hypotheses", () => {
    const s = [{ url: "https://a.org" }];
    expect(findingPriority({ evidence: "verified", confidence: 0.5, sources: s })).toBeGreaterThan(findingPriority({ evidence: "hypothesis", confidence: 1, sources: s }));
  });
  it("rewards independent sources", () => {
    expect(findingPriority({ evidence: "reported", sources: [{ url: "https://a.org/1" }, { url: "https://b.org/2" }] })).toBe(findingPriority({ evidence: "reported", sources: [{ url: "https://a.org" }] }) + 10);
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_REVENUE, canApprove, projectAnnual, type Handoff } from "./omni-handoff";

const base: Handoff = {
  id: "h", findingId: "f", title: "t", createdAt: "", sources: [], hypothesis: "", noveltyCaveat: "",
  feasibility: 3, requirements: "", risk: "low", priority: "low", estCost: 0, status: "approved",
  revenue: DEFAULT_REVENUE, provenance: { ownershipConfirmed: true, ossReviewed: true, noScrapedOrUnlicensed: false, notes: "" },
  approvals: { publish: false, pricing: false, deploy: false, sell: false },
};

describe("omni handoff rules", () => {
  it("projects annual gross from monthly inputs", () => {
    const r = { ...DEFAULT_REVENUE, saas: { price: 10, subscribers: 100 }, api: { pricePer1k: 2, callsPerMonth: 50000 } };
    expect(projectAnnual(r).total).toBe(12000 + 1200);
  });
  it("blocks selling until provenance is fully cleared", () => {
    expect(canApprove(base, "sell")).toBe(false);
    expect(canApprove({ ...base, provenance: { ...base.provenance, noScrapedOrUnlicensed: true } }, "sell")).toBe(true);
  });
  it("blocks every owner action until the handoff is approved", () => {
    expect(canApprove({ ...base, status: "pending" }, "deploy")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { EMPTY_GOV, canDistribute, dataProductCleared, potentialRevenue, type ReleaseManifest } from "./jax";

const cleared = { optIn: true, purpose: "benchmarks", aggregated: true, consentRecorded: true, retentionDays: 90, deletionSupported: true, accessPolicy: "licensees only", legalReviewed: true };
const m = (over: Partial<ReleaseManifest> = {}): ReleaseManifest => ({
  contract: "jax.release-manifest/0.1", id: "m", simulated: true, projectId: "p", handoffId: "h", name: "n", version: "1.0.0", owner: "o", createdAt: "",
  provenance: { ownershipConfirmed: true, ossReviewed: true, noScrapedOrUnlicensed: true, licenses: "" },
  features: [], permittedDataOutputs: [], dataProduct: { enabled: true, pricePerYear: 1000, licensees: 3, governance: EMPTY_GOV },
  pricing: { tiers: [] }, apiUsage: { callsPerMonth: 0, source: "estimate" },
  monetization: { saas: 500, licensing: 0, api: 0, marketplace: 0, services: 0 },
  distribution: { approved: false, approvedAt: null }, actualRevenue: null, audit: [], ...over,
});

describe("JAX rules", () => {
  it("excludes data-product revenue until governance is fully cleared", () => {
    expect(potentialRevenue(m()).total).toBe(500);
    expect(potentialRevenue(m({ dataProduct: { enabled: true, pricePerYear: 1000, licensees: 3, governance: cleared } })).total).toBe(3500);
  });
  it("rejects retention beyond 365 days or without consent", () => {
    expect(dataProductCleared({ ...cleared, retentionDays: 400 })).toBe(false);
    expect(dataProductCleared({ ...cleared, consentRecorded: false })).toBe(false);
  });
  it("blocks distribution when provenance is incomplete", () => {
    expect(canDistribute(m({ dataProduct: { ...m().dataProduct, enabled: false }, provenance: { ownershipConfirmed: true, ossReviewed: false, noScrapedOrUnlicensed: true, licenses: "" } }))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  canPrepareJaxDraft, enforceApprovals, normalizeDeviceHandoff, normalizeDeviceManifest, parseDeviceList,
  pendingDeviceIds, planImport, IMPORT_LIMIT,
} from "./owner-records";

const cleared = { ownershipConfirmed: true, ossReviewed: true, noScrapedOrUnlicensed: true, notes: "" };
const deviceHandoff = (id: string, over: Record<string, unknown> = {}) => ({
  id, findingId: "f1", title: `Idea ${id}`, createdAt: "2026-11-01T10:00:00.000Z", sources: ["https://example.com"],
  hypothesis: "h", noveltyCaveat: "c", feasibility: 4, requirements: "- a", risk: "low", priority: "high", estCost: 100,
  status: "approved", revenue: { saas: { price: 10, subscribers: 3 } }, provenance: cleared,
  approvals: { publish: true, pricing: false, deploy: true, sell: true }, ...over,
});

describe("owner records: device import", () => {
  it("keeps the browser record untouched as the original", () => {
    const raw = deviceHandoff("a");
    const n = normalizeDeviceHandoff(raw);
    expect(n.ok && n.row.original).toBe(raw);
    expect(n.ok && n.row.source_local_id).toBe("a");
    expect(n.ok && n.row.created_at).toBe("2026-11-01T10:00:00.000Z");
  });

  it("re-running the import adds nothing already saved, and duplicates in one batch count once", () => {
    const raws = [deviceHandoff("a"), deviceHandoff("b"), deviceHandoff("b")];
    const first = planImport(raws, normalizeDeviceHandoff, []);
    expect(first.add.map((r) => r.source_local_id)).toEqual(["a", "b"]);
    const second = planImport(raws, normalizeDeviceHandoff, ["a", "b"]);
    expect(second.add).toEqual([]);
    expect(second.alreadySaved).toBe(3);
  });

  it("skips unreadable records with a reason instead of inventing data", () => {
    const plan = planImport([{ title: "no id" }, { id: "x" }, "junk"], normalizeDeviceHandoff, []);
    expect(plan.add).toEqual([]);
    expect(plan.invalid.map((i) => i.reason)).toEqual(["missing or invalid id", "missing title", "missing or invalid id"]);
  });

  it(`stops at ${IMPORT_LIMIT} records per import`, () => {
    const raws = Array.from({ length: IMPORT_LIMIT + 3 }, (_, i) => deviceHandoff(`id${i}`));
    const plan = planImport(raws, normalizeDeviceHandoff, []);
    expect(plan.add).toHaveLength(IMPORT_LIMIT);
    expect(plan.invalid).toHaveLength(3);
  });

  it("imported JAX manifests are always simulated with no actual revenue", () => {
    const n = normalizeDeviceManifest({ id: "m1", name: "Pkg", version: "1.0.0", simulated: false, actualRevenue: 5000, handoffId: "a" });
    expect(n.ok && n.row.manifest.simulated).toBe(true);
    expect(n.ok && n.row.manifest.actualRevenue).toBeNull();
    expect(n.ok && n.row.source_handoff_local_id).toBe("a");
    expect(n.ok && (n.row.original as { actualRevenue: number }).actualRevenue).toBe(5000);
  });

  it("reads device lists safely and lists only records not yet saved", () => {
    expect(parseDeviceList("not json", "handoffs")).toEqual([]);
    expect(parseDeviceList(null, "manifests")).toEqual([]);
    const list = parseDeviceList(JSON.stringify({ handoffs: [deviceHandoff("a"), deviceHandoff("b")] }), "handoffs");
    expect(pendingDeviceIds(list, ["a"])).toEqual(["b"]);
  });
});

describe("owner records: approval rules", () => {
  it("drops every approval when the handoff is not approved", () => {
    expect(enforceApprovals("pending", cleared, { publish: true, pricing: true, deploy: true, sell: true }))
      .toEqual({ publish: false, pricing: false, deploy: false, sell: false });
  });
  it("publish, pricing and sell need all three provenance boxes; deploy needs only approval", () => {
    const partial = { ...cleared, ossReviewed: false };
    expect(enforceApprovals("approved", partial, { publish: true, pricing: true, deploy: true, sell: true }))
      .toEqual({ publish: false, pricing: false, deploy: true, sell: false });
    const n = normalizeDeviceHandoff(deviceHandoff("a", { status: "rejected" }));
    expect(n.ok && n.row.approvals).toEqual({ publish: false, pricing: false, deploy: false, sell: false });
  });
  it("a JAX draft needs an approved handoff with provenance cleared", () => {
    expect(canPrepareJaxDraft({ status: "approved", provenance: cleared })).toBe(true);
    expect(canPrepareJaxDraft({ status: "pending", provenance: cleared })).toBe(false);
    expect(canPrepareJaxDraft({ status: "approved", provenance: { ...cleared, noScrapedOrUnlicensed: false } })).toBe(false);
  });
});

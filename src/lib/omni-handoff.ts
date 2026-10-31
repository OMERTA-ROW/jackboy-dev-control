import { useSyncExternalStore } from "react";
import { log } from "./jackboy-store";

export type HandoffStatus = "draft" | "pending" | "approved" | "rejected";
export type Revenue = {
  saas: { price: number; subscribers: number };
  licensing: { price: number; deals: number }; // per year
  api: { pricePer1k: number; callsPerMonth: number };
  marketplace: { price: number; salesPerMonth: number };
  services: { rate: number; hoursPerMonth: number };
};
export type Provenance = {
  ownershipConfirmed: boolean; // owner confirms all original code/assets are theirs
  ossReviewed: boolean; // third-party licenses and obligations reviewed
  noScrapedOrUnlicensed: boolean; // no scraped code, copyrighted or unlicensed assets included
  notes: string;
};
export type OwnerAction = "publish" | "pricing" | "deploy" | "sell";
export type Handoff = {
  id: string; findingId: string; title: string; createdAt: string;
  sources: string[]; hypothesis: string; noveltyCaveat: string;
  feasibility: number; requirements: string; risk: "low" | "medium" | "high";
  priority: "low" | "medium" | "high"; estCost: number; status: HandoffStatus;
  revenue: Revenue; provenance: Provenance; approvals: Record<OwnerAction, boolean>;
};

export const DEFAULT_REVENUE: Revenue = {
  saas: { price: 0, subscribers: 0 }, licensing: { price: 0, deals: 0 },
  api: { pricePer1k: 0, callsPerMonth: 0 }, marketplace: { price: 0, salesPerMonth: 0 },
  services: { rate: 0, hoursPerMonth: 0 },
};

/** Projected gross revenue per year by stream. Estimates only — not actual earnings. */
export function projectAnnual(r: Revenue) {
  const streams = {
    saas: r.saas.price * r.saas.subscribers * 12,
    licensing: r.licensing.price * r.licensing.deals,
    api: (r.api.callsPerMonth / 1000) * r.api.pricePer1k * 12,
    marketplace: r.marketplace.price * r.marketplace.salesPerMonth * 12,
    services: r.services.rate * r.services.hoursPerMonth * 12,
  };
  return { streams, total: Object.values(streams).reduce((a, b) => a + b, 0) };
}

/** Selling/publishing is only allowed once provenance is fully cleared AND the owner approved the action. */
export function canApprove(h: Handoff, action: OwnerAction): boolean {
  const p = h.provenance;
  const cleared = p.ownershipConfirmed && p.ossReviewed && p.noScrapedOrUnlicensed;
  if (action === "sell" || action === "publish" || action === "pricing") return cleared && h.status === "approved";
  return h.status === "approved";
}

export function toMarkdown(h: Handoff): string {
  const { streams, total } = projectAnnual(h.revenue);
  return `# OMNI Handoff Brief — ${h.title}
Status: ${h.status} · Priority: ${h.priority} · Risk: ${h.risk} · Created: ${h.createdAt}
> Prepared by Jackboy (research/evaluation). OMNI integration NOT verified — export for manual handoff.

## Sources
${h.sources.map((s) => `- ${s}`).join("\n")}

## Technical hypothesis (AI, unverified)
${h.hypothesis}

## Novelty caveat
${h.noveltyCaveat}

## Feasibility: ${h.feasibility}/5 · Estimated build cost (estimate): $${h.estCost.toLocaleString()}

## Proposed requirements
${h.requirements}

## Monetization plan — PROJECTED ESTIMATES, NOT ACTUAL EARNINGS
${Object.entries(streams).map(([k, v]) => `- ${k}: $${Math.round(v).toLocaleString()}/yr`).join("\n")}
- Total projected gross: $${Math.round(total).toLocaleString()}/yr

## Provenance
- Ownership confirmed: ${h.provenance.ownershipConfirmed}
- Open-source obligations reviewed: ${h.provenance.ossReviewed}
- No scraped/copyrighted/unlicensed material: ${h.provenance.noScrapedOrUnlicensed}
- Notes: ${h.provenance.notes || "—"}

## Owner approvals
${Object.entries(h.approvals).map(([k, v]) => `- ${k}: ${v ? "approved" : "not approved"}`).join("\n")}
`;
}

type S = { handoffs: Handoff[] };
const KEY = "jackboy:omni:v1";
const initial: S = { handoffs: [] };
let state = initial; let loaded = false;
const ls = new Set<() => void>();
function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try { const r = localStorage.getItem(KEY); if (r) state = { ...initial, ...JSON.parse(r) }; } catch { /* ignore */ }
}
function set(fn: (s: S) => S, msg?: string, level: "info" | "approval" = "info") {
  load(); state = fn(state);
  if (typeof window !== "undefined") localStorage.setItem(KEY, JSON.stringify(state));
  ls.forEach((l) => l());
  if (msg) log(level, `OMNI handoff: ${msg}`);
}
export function addHandoff(h: Omit<Handoff, "id" | "createdAt" | "status" | "revenue" | "provenance" | "approvals">) {
  set((s) => ({ handoffs: [{ ...h, id: crypto.randomUUID(), createdAt: new Date().toISOString(), status: "pending", revenue: DEFAULT_REVENUE,
    provenance: { ownershipConfirmed: false, ossReviewed: false, noScrapedOrUnlicensed: false, notes: "" },
    approvals: { publish: false, pricing: false, deploy: false, sell: false } }, ...s.handoffs] }), `queued "${h.title}" for owner review`);
}
export function updateHandoff(id: string, fn: (h: Handoff) => Handoff, msg?: string, level: "info" | "approval" = "info") {
  set((s) => ({ handoffs: s.handoffs.map((h) => (h.id === id ? fn(h) : h)) }), msg, level);
}
export function removeHandoff(id: string) {
  set((s) => ({ handoffs: s.handoffs.filter((h) => h.id !== id) }), "removed a handoff");
}
export function useHandoffs() {
  return useSyncExternalStore((l) => { ls.add(l); if (!loaded) { load(); queueMicrotask(l); } return () => ls.delete(l); }, () => state, () => initial).handoffs;
}

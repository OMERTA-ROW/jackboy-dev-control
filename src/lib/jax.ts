import { projectAnnual, type Handoff } from "./omni-handoff";

export const CONTRACT_VERSION = "jax.release-manifest/0.1";
export const PROHIBITED = [
  "Source code", "User data", "Credentials or secrets", "Personal information",
  "Raw telemetry", "Proprietary third-party content", "Vault data",
] as const;

export type DataGovernance = {
  optIn: boolean; purpose: string; aggregated: boolean; consentRecorded: boolean;
  retentionDays: number; deletionSupported: boolean; accessPolicy: string; legalReviewed: boolean;
};
export type ReleaseManifest = {
  contract: typeof CONTRACT_VERSION;
  id: string; simulated: true; // always true until OMNI/JAX are verified
  projectId: string; handoffId: string; name: string; version: string; owner: string; createdAt: string;
  provenance: { ownershipConfirmed: boolean; ossReviewed: boolean; noScrapedOrUnlicensed: boolean; licenses: string };
  features: string[];
  permittedDataOutputs: string[]; // aggregated, de-identified outputs only
  dataProduct: { enabled: boolean; pricePerYear: number; licensees: number; governance: DataGovernance };
  pricing: { tiers: { name: string; pricePerMonth: number; entitlements: string }[] };
  apiUsage: { callsPerMonth: number; source: "estimate" };
  monetization: ReturnType<typeof projectAnnual>["streams"];
  distribution: { approved: boolean; approvedAt: string | null };
  actualRevenue: null; // only populated by verified payment integration — none connected
  audit: { at: string; event: string }[];
};

export const EMPTY_GOV: DataGovernance = {
  optIn: false, purpose: "", aggregated: false, consentRecorded: false,
  retentionDays: 90, deletionSupported: false, accessPolicy: "", legalReviewed: false,
};

/** A data product may be counted or distributed only when every governance check passes. */
export function dataProductCleared(g: DataGovernance): boolean {
  return g.optIn && g.aggregated && g.consentRecorded && g.deletionSupported && g.legalReviewed
    && g.purpose.trim().length > 0 && g.accessPolicy.trim().length > 0 && g.retentionDays > 0 && g.retentionDays <= 365;
}

/** JAX potential (estimated) annual revenue. Data products contribute only if enabled AND cleared. */
export function potentialRevenue(m: ReleaseManifest) {
  const base = Object.values(m.monetization).reduce((a, b) => a + b, 0);
  const dp = m.dataProduct.enabled && dataProductCleared(m.dataProduct.governance)
    ? m.dataProduct.pricePerYear * m.dataProduct.licensees : 0;
  return { base, dataProduct: dp, total: base + dp };
}

/** Distribution requires owner-approved handoff + cleared provenance; data products also need governance. */
export function canDistribute(m: ReleaseManifest): boolean {
  const p = m.provenance;
  const ok = p.ownershipConfirmed && p.ossReviewed && p.noScrapedOrUnlicensed;
  return ok && (!m.dataProduct.enabled || dataProductCleared(m.dataProduct.governance));
}

export function manifestFromHandoff(h: Handoff, version: string, owner: string): ReleaseManifest {
  const now = new Date().toISOString();
  return {
    contract: CONTRACT_VERSION, id: crypto.randomUUID(), simulated: true,
    projectId: `proj-${h.id.slice(0, 8)}`, handoffId: h.id, name: h.title, version, owner, createdAt: now,
    provenance: { ...h.provenance, licenses: h.provenance.notes },
    features: h.requirements.split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean),
    permittedDataOutputs: [],
    dataProduct: { enabled: false, pricePerYear: 0, licensees: 0, governance: EMPTY_GOV },
    pricing: { tiers: h.revenue.saas.price ? [{ name: "Standard", pricePerMonth: h.revenue.saas.price, entitlements: "Core features" }] : [] },
    apiUsage: { callsPerMonth: h.revenue.api.callsPerMonth, source: "estimate" },
    monetization: projectAnnual(h.revenue).streams,
    distribution: { approved: false, approvedAt: null },
    actualRevenue: null,
    audit: [{ at: now, event: `Simulated release v${version} created from approved handoff` }],
  };
}

/** Machine-readable integration contract for future OMNI → JAX wiring. */
export const INTEGRATION_CONTRACT = {
  contract: CONTRACT_VERSION,
  direction: "OMNI (release) → JAX (ingest); Jackboy UI is a mock producer until verified",
  transport: "HTTPS POST /releases with signed JSON body (endpoint TBD by JAX owner)",
  auth: "Server-side credentials only; never in client code",
  requiredFields: ["contract", "projectId", "version", "owner", "provenance", "features", "permittedDataOutputs", "pricing", "apiUsage", "monetization", "distribution", "audit"],
  rules: [
    "simulated=true manifests must never be counted as real releases",
    "actualRevenue may only be set by a verified payment integration",
    "dataProduct revenue counts only when every governance check passes",
    `Never include: ${PROHIBITED.join(", ")}`,
    "Distribution requires explicit owner approval recorded in audit",
  ],
};

// Draft manifests are stored per owner in the database (owner-records.functions.ts). Older browser-only
// copies under "jackboy:jax:v1" are read only for the one-press import and never modified.

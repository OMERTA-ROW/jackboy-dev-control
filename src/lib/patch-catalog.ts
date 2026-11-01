// Native patch catalog + vulnerability-prioritized triage + ring deferrals + exceptions. Pure and tested; feeds endpoint-policy and the Foundry loop.
import type { Ring, Severity } from "./endpoint-policy";

export type CatalogEntry = {
  id: string;            // stable source id, e.g. "github:owner/repo@1.2.3" or advisory id
  source: "github_release" | "os_vendor" | "language_registry" | "vendor" | "foundry";
  product: string;
  version: string;
  severity: Severity;
  cvss: number | null;   // 0-10 when a trusted advisory provides it
  exploited: boolean;    // listed as known-exploited by a trusted feed
  publishedAt: string;   // ISO
  signed: boolean;
  licenseOk: boolean;
};

const SEV: Record<Severity, number> = { none: 0, low: 10, medium: 30, high: 55, critical: 75 };

/** 0-100. Known exploitation and CVSS dominate; age adds urgency (max +10 after 30 days). Unsigned or license-blocked entries score 0. */
export function priorityScore(e: CatalogEntry, exposedEndpoints: number, now: Date): number {
  if (!e.signed || !e.licenseOk) return 0;
  const days = Math.max(0, (now.getTime() - new Date(e.publishedAt).getTime()) / 86_400_000);
  const base = Math.max(SEV[e.severity], e.cvss != null ? e.cvss * 7.5 : 0);
  const s = base + (e.exploited ? 20 : 0) + Math.min(10, days / 3) + (exposedEndpoints > 0 ? Math.min(5, Math.log2(1 + exposedEndpoints)) : -100);
  return Math.max(0, Math.min(100, Math.round(s)));
}

/** Deduplicate by id (newest publishedAt wins) and sort by priority, highest first. */
export function triage(entries: CatalogEntry[], exposure: Record<string, number>, now: Date) {
  const byId = new Map<string, CatalogEntry>();
  for (const e of entries) {
    const prev = byId.get(e.id);
    if (!prev || prev.publishedAt < e.publishedAt) byId.set(e.id, e);
  }
  return [...byId.values()]
    .map((e) => ({ entry: e, score: priorityScore(e, exposure[e.product] ?? 0, now) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
}

/** Ring deferral in days. Exploited critical patches shorten (never skip) deferral; canary is always first. */
export const RING_DEFERRAL_DAYS: Record<Ring, number> = { canary: 0, early: 3, broad: 7 };

export function ringsOpen(e: CatalogEntry, approvedAt: Date, now: Date, canaryHealthy: boolean): Ring[] {
  const days = (now.getTime() - approvedAt.getTime()) / 86_400_000;
  const factor = e.exploited && e.severity === "critical" ? 1 / 3 : 1;
  const out: Ring[] = ["canary"];
  if (!canaryHealthy) return out;
  if (days >= RING_DEFERRAL_DAYS.early * factor) out.push("early");
  if (days >= RING_DEFERRAL_DAYS.broad * factor) out.push("broad");
  return out;
}

/** Owner exceptions: exclude a product (optionally only up to a version) for an endpoint group until an expiry. Expired exceptions are ignored. */
export type PatchException = { group: string; product: string; untilVersion?: string; expiresAt: string; reason: string };

export function isExcepted(e: CatalogEntry, group: string, ex: PatchException[], now: Date): PatchException | null {
  return ex.find((x) => x.group === group && x.product === e.product && new Date(x.expiresAt) > now && (!x.untilVersion || e.version <= x.untilVersion)) ?? null;
}

/** Canonical loop order; a job may only move to the next stage. */
export const LOOP_STAGES = ["collect", "prioritize", "select_repair", "check", "test", "approve", "distribute", "verify", "log", "next"] as const;
export type LoopStage = (typeof LOOP_STAGES)[number];
export function nextStage(s: LoopStage, failed: boolean): LoopStage | "rollback" {
  if (failed && (s === "distribute" || s === "verify")) return "rollback";
  if (failed) return "log";
  const i = LOOP_STAGES.indexOf(s);
  return LOOP_STAGES[Math.min(i + 1, LOOP_STAGES.length - 1)]!;
}

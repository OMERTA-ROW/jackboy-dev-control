/**
 * Owner-scoped OMNI research handoffs and JAX draft manifests: pure rules shared by the
 * browser (device import) and the server functions. The server re-normalizes everything the
 * browser sends, so these rules are the single gate for imported data.
 */
import { DEFAULT_REVENUE, type Handoff, type OwnerAction, type Provenance, type Revenue } from "./omni-handoff";
import { CONTRACT_VERSION, type ReleaseManifest } from "./jax";

/** Browser storage keys used before records moved to the owner's account. */
export const DEVICE_HANDOFF_KEY = "jackboy:omni:v1";
export const DEVICE_JAX_KEY = "jackboy:jax:v1";
export const IMPORT_LIMIT = 200;
const ORIGINAL_MAX_BYTES = 100_000;

const LEVELS = ["low", "medium", "high"] as const;
const STATUSES = ["draft", "pending", "approved", "rejected"] as const;
const ACTIONS: OwnerAction[] = ["publish", "pricing", "deploy", "sell"];

export type HandoffRow = {
  id: string; owner_id: string; source_local_id: string | null; finding_id: string; title: string;
  sources: unknown; hypothesis: string; novelty_caveat: string; feasibility: number | string;
  requirements: string; risk: string; priority: string; est_cost: number | string; status: string;
  revenue: unknown; provenance: unknown; approvals: unknown; original: unknown;
  imported_at: string | null; archived_at: string | null; created_at: string; updated_at: string;
};
export type HandoffInsert = {
  source_local_id: string; finding_id: string; title: string; sources: string[]; hypothesis: string;
  novelty_caveat: string; feasibility: number; requirements: string; risk: Handoff["risk"];
  priority: Handoff["priority"]; est_cost: number; status: Handoff["status"]; revenue: Revenue;
  provenance: Provenance; approvals: Record<OwnerAction, boolean>; original: unknown; created_at?: string | undefined;
};
export type ManifestInsert = {
  source_local_id: string; source_handoff_local_id: string | null; name: string; version: string;
  manifest: ReleaseManifest; original: unknown; created_at?: string | undefined;
};
export type SavedHandoff = Handoff & { importedAt: string | null; archivedAt: string | null; fromDevice: boolean };

type Normalized<T> = { ok: true; row: T } | { ok: false; reason: string };

type KnownKey = "id" | "title" | "findingId" | "sources" | "hypothesis" | "noveltyCaveat" | "feasibility" | "requirements"
  | "risk" | "priority" | "estCost" | "status" | "revenue" | "provenance" | "approvals" | "createdAt" | "name" | "version"
  | "contract" | "handoffId" | "ownershipConfirmed" | "ossReviewed" | "noScrapedOrUnlicensed" | "notes"
  | "publish" | "pricing" | "sell" | "deploy";
type Loose = { [K in KnownKey]?: unknown } & Record<string, unknown>;
const obj = (v: unknown): Loose => (v && typeof v === "object" && !Array.isArray(v) ? (v as Loose) : {});
const str = (v: unknown, max: number, fallback = "") => (typeof v === "string" ? v.slice(0, max) : fallback);
const num = (v: unknown, min: number, max: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
};
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const bool = (v: unknown) => v === true;
const isoOrUndefined = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);
const sizeOk = (v: unknown) => {
  try { return JSON.stringify(v).length <= ORIGINAL_MAX_BYTES; } catch { return false; }
};

export function normalizeRevenue(v: unknown): Revenue {
  const r = obj(v);
  const out = structuredClone(DEFAULT_REVENUE) as Record<string, Record<string, number>>;
  for (const [stream, fields] of Object.entries(out)) {
    const src = obj(r[stream]);
    for (const k of Object.keys(fields)) fields[k] = num(src[k], 0, 1e12);
  }
  return out as unknown as Revenue;
}
export function normalizeProvenance(v: unknown): Provenance {
  const p = obj(v);
  return { ownershipConfirmed: bool(p.ownershipConfirmed), ossReviewed: bool(p.ossReviewed), noScrapedOrUnlicensed: bool(p.noScrapedOrUnlicensed), notes: str(p.notes, 4000) };
}
export const provenanceCleared = (p: Provenance) => p.ownershipConfirmed && p.ossReviewed && p.noScrapedOrUnlicensed;

/** Mirrors the database trigger: nothing stays approved unless the handoff is approved,
 * and publish/pricing/sell also need the full provenance checklist. */
export function enforceApprovals(status: Handoff["status"], provenance: Provenance, approvals: unknown): Record<OwnerAction, boolean> {
  const a = obj(approvals);
  const approved = status === "approved";
  const cleared = provenanceCleared(provenance);
  return {
    publish: approved && cleared && bool(a.publish),
    pricing: approved && cleared && bool(a.pricing),
    sell: approved && cleared && bool(a.sell),
    deploy: approved && bool(a.deploy),
  };
}

/** One browser-saved handoff → database row. The untouched browser record travels in `original`. */
export function normalizeDeviceHandoff(raw: unknown): Normalized<HandoffInsert> {
  const h = obj(raw);
  const id = str(h.id, 200).trim();
  const title = str(h.title, 300).trim();
  if (!id || id.length > 120) return { ok: false, reason: "missing or invalid id" };
  if (!title) return { ok: false, reason: "missing title" };
  if (!sizeOk(raw)) return { ok: false, reason: "record too large" };
  const status = pick(h.status, STATUSES, "pending");
  const provenance = normalizeProvenance(h.provenance);
  return {
    ok: true,
    row: {
      source_local_id: id, finding_id: str(h.findingId, 200), title,
      sources: (Array.isArray(h.sources) ? h.sources : []).filter((s): s is string => typeof s === "string").slice(0, 50).map((s) => s.slice(0, 1000)),
      hypothesis: str(h.hypothesis, 8000), novelty_caveat: str(h.noveltyCaveat, 4000),
      feasibility: num(h.feasibility, 0, 5), requirements: str(h.requirements, 20000),
      risk: pick(h.risk, LEVELS, "medium"), priority: pick(h.priority, LEVELS, "medium"),
      est_cost: num(h.estCost, 0, 1e12), status, revenue: normalizeRevenue(h.revenue), provenance,
      approvals: enforceApprovals(status, provenance, h.approvals), original: raw, created_at: isoOrUndefined(h.createdAt),
    },
  };
}

/** One browser-saved JAX manifest → database row. Always stays simulated with no actual revenue. */
export function normalizeDeviceManifest(raw: unknown): Normalized<ManifestInsert> {
  const m = obj(raw);
  const id = str(m.id, 200).trim();
  const name = str(m.name, 300).trim();
  if (!id || id.length > 120) return { ok: false, reason: "missing or invalid id" };
  if (!name) return { ok: false, reason: "missing name" };
  if (!sizeOk(raw)) return { ok: false, reason: "record too large" };
  const version = str(m.version, 40).trim() || "0.1.0";
  const manifest = { ...m, contract: str(m.contract, 60).startsWith("jax.release-manifest/") ? m.contract : CONTRACT_VERSION, name, version, simulated: true, actualRevenue: null } as unknown as ReleaseManifest;
  const handoff = str(m.handoffId, 200).trim();
  return { ok: true, row: { source_local_id: id, source_handoff_local_id: handoff || null, name, version, manifest, original: raw, created_at: isoOrUndefined(m.createdAt) } };
}

export type ImportPlan<T> = { add: T[]; alreadySaved: number; invalid: { id: string; reason: string }[] };

/** Splits device records into new rows, ones already in the account (same source id) and invalid ones. */
export function planImport<T extends { source_local_id: string }>(raws: unknown[], normalize: (r: unknown) => Normalized<T>, savedSourceIds: Iterable<string>): ImportPlan<T> {
  const saved = new Set(savedSourceIds);
  const seen = new Set<string>();
  const plan: ImportPlan<T> = { add: [], alreadySaved: 0, invalid: [] };
  for (const raw of raws.slice(0, IMPORT_LIMIT)) {
    const n = normalize(raw);
    if (!n.ok) { plan.invalid.push({ id: str(obj(raw).id, 60) || "(no id)", reason: n.reason }); continue; }
    if (saved.has(n.row.source_local_id)) { plan.alreadySaved++; continue; }
    if (seen.has(n.row.source_local_id)) continue;
    seen.add(n.row.source_local_id);
    plan.add.push(n.row);
  }
  for (const raw of raws.slice(IMPORT_LIMIT)) plan.invalid.push({ id: str(obj(raw).id, 60) || "(no id)", reason: `over the ${IMPORT_LIMIT}-record limit` });
  return plan;
}

/** Reads the browser-saved lists; anything unreadable counts as empty. Never modifies storage. */
export function parseDeviceList(text: string | null, field: "handoffs" | "manifests"): unknown[] {
  if (!text) return [];
  try {
    const list = obj(JSON.parse(text))[field];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Device records not yet in the account, by their original browser id. */
export function pendingDeviceIds(raws: unknown[], savedSourceIds: Iterable<string>): string[] {
  const saved = new Set(savedSourceIds);
  return raws.map((r) => str(obj(r).id, 200).trim()).filter((id) => id && !saved.has(id));
}

export function rowToHandoff(r: HandoffRow): SavedHandoff {
  const provenance = normalizeProvenance(r.provenance);
  const status = pick(r.status, STATUSES, "pending");
  return {
    id: r.id, findingId: r.finding_id, title: r.title, createdAt: r.created_at,
    sources: Array.isArray(r.sources) ? r.sources.filter((s): s is string => typeof s === "string") : [],
    hypothesis: r.hypothesis, noveltyCaveat: r.novelty_caveat, feasibility: Number(r.feasibility) || 0,
    requirements: r.requirements, risk: pick(r.risk, LEVELS, "medium"), priority: pick(r.priority, LEVELS, "medium"),
    estCost: Number(r.est_cost) || 0, status, revenue: normalizeRevenue(r.revenue), provenance,
    approvals: enforceApprovals(status, provenance, r.approvals),
    importedAt: r.imported_at, archivedAt: r.archived_at, fromDevice: r.source_local_id !== null,
  };
}

/** A JAX draft may be prepared only from an approved handoff with the provenance checklist cleared. */
export function canPrepareJaxDraft(h: Pick<Handoff, "status" | "provenance">): boolean {
  return h.status === "approved" && provenanceCleared(h.provenance);
}

export const OWNER_ACTIONS = ACTIONS;

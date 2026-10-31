import { useSyncExternalStore } from "react";
import { log } from "./jackboy-store";

export type SourceKind = "lab" | "papers" | "patents" | "standards" | "opensource" | "news";
export type Maturity = "research" | "prototype" | "pilot" | "commercial";
export type Source = {
  id: string; name: string; kind: SourceKind; url: string;
  access: "Public API" | "RSS" | "Bulk data"; terms: string; rateLimit: string; enabled: boolean;
};
export type Finding = {
  id: string; title: string; url: string; sourceId: string; publishedAt: string; fetchedAt: string;
  sector: string; maturity: Maturity; evidence: string; // verified: quoted from source metadata
  gap: string; idea: string; priorArt: string; // AI hypotheses (demo text)
  scores: { novelty: number; feasibility: number; impact: number; confidence: number }; // 0–5
  creator?: Creator; track?: Track; visibility?: Visibility; benefit?: number; // societal benefit 0–5
  claimStatus?: "validated" | "reported" | "speculative";
};
export type Creator = "institution" | "corporate" | "startup" | "independent" | "small-lab" | "oss-maintainer" | "student";
export type Track = "commercial" | "frontier";
export type Visibility = "low" | "medium" | "high";
export const UNDERDOG: Creator[] = ["startup", "independent", "small-lab", "oss-maintainer", "student"];
export const CREATOR_LABEL: Record<Creator, string> = {
  institution: "Institution", corporate: "Corporate", startup: "Startup", independent: "Independent inventor",
  "small-lab": "Small lab", "oss-maintainer": "Open-source maintainer", student: "Student project",
};

/** Defaults for older rows without origin metadata. */
const ORIGIN: Record<string, Pick<Finding, "creator" | "track" | "visibility" | "benefit" | "claimStatus">> = {
  f1: { creator: "institution", track: "frontier", visibility: "medium", benefit: 4, claimStatus: "reported" },
  f2: { creator: "institution", track: "commercial", visibility: "high", benefit: 3, claimStatus: "validated" },
  f3: { creator: "oss-maintainer", track: "frontier", visibility: "low", benefit: 4, claimStatus: "reported" },
  f4: { creator: "institution", track: "frontier", visibility: "medium", benefit: 5, claimStatus: "reported" },
};
export function meta(f: Finding) {
  const o = ORIGIN[f.id] ?? {};
  return {
    creator: f.creator ?? o.creator ?? "institution", track: f.track ?? o.track ?? "commercial",
    visibility: f.visibility ?? o.visibility ?? "medium", benefit: f.benefit ?? o.benefit ?? f.scores.impact,
    claimStatus: f.claimStatus ?? o.claimStatus ?? "reported",
  } as Required<Pick<Finding, "creator" | "track" | "visibility" | "benefit" | "claimStatus">>;
}

/**
 * Frontier/underdog score 0–100. Rule "Never overlook the little guy":
 * funding, publicity, citations, team size and sales are deliberately NOT inputs.
 */
export function frontierScore(f: Finding): number {
  const m = meta(f);
  const w = f.scores.novelty * 0.3 + f.scores.feasibility * 0.25 + m.benefit * 0.3 + f.scores.confidence * 0.15;
  return Math.round((w / 5) * 100);
}

/** Explainable "overlooked gem" reasons; empty array = not a gem. Low visibility only ever helps. */
export function gemReasons(f: Finding): string[] {
  const m = meta(f);
  if (m.track !== "frontier" || f.scores.feasibility < 3) return [];
  const r: string[] = [];
  if (UNDERDOG.includes(m.creator)) r.push(`${CREATOR_LABEL[m.creator]} — under-resourced creators are prioritised, not penalised`);
  if (m.visibility === "low") r.push("Low publicity relative to technical promise");
  if (f.scores.novelty >= 4) r.push(`High potential novelty (${f.scores.novelty}/5, unverified)`);
  if (m.benefit >= 4) r.push(`High societal benefit (${m.benefit}/5)`);
  return r.length >= 3 ? r : [];
}

/** Interleave tracks so at least `frontierShare`% of the top slots go to frontier items (when available). */
export function mixTracks(commercial: Finding[], frontier: Finding[], frontierShare: number): Finding[] {
  const out: Finding[] = []; let c = 0, fr = 0;
  const share = Math.min(100, Math.max(0, frontierShare)) / 100;
  while (c < commercial.length || fr < frontier.length) {
    const needFrontier = fr < frontier.length && (c >= commercial.length || fr < Math.ceil((out.length + 1) * share));
    out.push((needFrontier ? frontier[fr++] : commercial[c++])!);
  }
  return out;
}

/** Weighted opportunity score 0–100. Confidence weighs most so weak evidence never tops the list. */
export function rankScore(s: Finding["scores"]): number {
  const w = s.novelty * 0.25 + s.feasibility * 0.2 + s.impact * 0.25 + s.confidence * 0.3;
  return Math.round((w / 5) * 100);
}

/** Dedupe by normalised URL, then by case-insensitive title. Keeps first occurrence. */
export function dedupe<T extends { url: string; title: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const u = "u:" + i.url.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[/?#]+$/, "");
    const t = "t:" + i.title.trim().toLowerCase();
    if (seen.has(u) || seen.has(t)) return false;
    seen.add(u); seen.add(t);
    return true;
  });
}

export const SOURCES: Source[] = [
  { id: "arxiv", name: "arXiv", kind: "papers", url: "https://export.arxiv.org/api/query", access: "Public API", terms: "arXiv API Terms of Use; metadata CC0", rateLimit: "1 request / 3 s", enabled: true },
  { id: "openalex", name: "OpenAlex", kind: "papers", url: "https://api.openalex.org", access: "Public API", terms: "CC0 data", rateLimit: "10 req/s, 100k/day", enabled: true },
  { id: "uspto", name: "USPTO Open Data", kind: "patents", url: "https://developer.uspto.gov", access: "Public API", terms: "USPTO API terms; key required", rateLimit: "Per API key", enabled: false },
  { id: "epo", name: "EPO Open Patent Services", kind: "patents", url: "https://www.epo.org/en/searching-for-patents/data/web-services/ops", access: "Public API", terms: "OPS fair use; registration required", rateLimit: "Weekly quota", enabled: false },
  { id: "ietf", name: "IETF Datatracker", kind: "standards", url: "https://datatracker.ietf.org/api/", access: "Public API", terms: "IETF Trust legal provisions", rateLimit: "Polite use", enabled: true },
  { id: "w3c", name: "W3C TR feed", kind: "standards", url: "https://www.w3.org/TR/", access: "RSS", terms: "W3C document license", rateLimit: "Polite use", enabled: true },
  { id: "github", name: "GitHub Search", kind: "opensource", url: "https://api.github.com/search/repositories", access: "Public API", terms: "GitHub ToS; respect repo licenses", rateLimit: "10 req/min unauthenticated", enabled: false },
  { id: "nist", name: "NIST news", kind: "lab", url: "https://www.nist.gov/news-events/news/rss.xml", access: "RSS", terms: "Public domain (US Gov)", rateLimit: "Polite use", enabled: true },
  { id: "mitnews", name: "MIT News — Research", kind: "lab", url: "https://news.mit.edu/rss/research", access: "RSS", terms: "Headlines/links only; link to original", rateLimit: "Polite use", enabled: true },
  { id: "hn", name: "Hacker News (Algolia)", kind: "news", url: "https://hn.algolia.com/api", access: "Public API", terms: "Link to original articles", rateLimit: "10k req/hour", enabled: false },
];

const d = (s: string) => new Date(s).toISOString();
export const DEMO_FINDINGS: Finding[] = [
  { id: "f1", title: "Solid-state sodium battery with sulfide electrolyte", url: "https://arxiv.org/abs/demo.0001", sourceId: "arxiv", publishedAt: d("2026-10-20"), fetchedAt: d("2026-10-30"), sector: "Energy", maturity: "research",
    evidence: "Preprint reports lab-scale cells; abstract cites stable cycling at room temperature.", gap: "No data on manufacturing cost or cold-climate performance.", idea: "Low-cost home storage module for cold regions using sodium cells.", priorArt: "Several commercial sodium-ion products exist; solid-state variants largely in research.", scores: { novelty: 4, feasibility: 2, impact: 4, confidence: 3 } },
  { id: "f2", title: "Draft standard for post-quantum TLS key exchange", url: "https://datatracker.ietf.org/doc/demo-pq-tls/", sourceId: "ietf", publishedAt: d("2026-10-12"), fetchedAt: d("2026-10-30"), sector: "Security", maturity: "pilot",
    evidence: "Internet-Draft revision published by working group.", gap: "Few developer tools audit apps for PQ readiness.", idea: "Jackboy check that flags non-PQ-ready TLS configs in repos.", priorArt: "Some scanners exist; integration in dev dashboards uncommon.", scores: { novelty: 3, feasibility: 5, impact: 3, confidence: 4 } },
  { id: "f3", title: "Open-source on-device speech model under 50MB", url: "https://github.com/demo/tiny-speech", sourceId: "github", publishedAt: d("2026-10-25"), fetchedAt: d("2026-10-30"), sector: "AI", maturity: "prototype",
    evidence: "Repository README lists model size and Apache-2.0 license.", gap: "No accessibility-focused tooling for offline captioning on older phones.", idea: "Offline live-caption app for low-end devices.", priorArt: "Built-in captioning exists on newer phones.", scores: { novelty: 3, feasibility: 4, impact: 4, confidence: 3 } },
  { id: "f4", title: "Biodegradable sensor patches for crop moisture", url: "https://www.nist.gov/news/demo-sensors", sourceId: "nist", publishedAt: d("2026-09-30"), fetchedAt: d("2026-10-30"), sector: "Agriculture", maturity: "research",
    evidence: "Lab announcement describes printed sensors that dissolve after a season.", gap: "No low-cost reader network for smallholder farms.", idea: "Shared phone-based reader service for co-ops.", priorArt: "Commercial soil probes exist (non-degradable).", scores: { novelty: 4, feasibility: 3, impact: 4, confidence: 2 } },
  { id: "f4b", title: "Biodegradable Sensor Patches for Crop Moisture", url: "https://nist.gov/news/demo-sensors/", sourceId: "nist", publishedAt: d("2026-09-30"), fetchedAt: d("2026-10-30"), sector: "Agriculture", maturity: "research",
    evidence: "Duplicate (demonstrates dedupe).", gap: "", idea: "", priorArt: "", scores: { novelty: 0, feasibility: 0, impact: 0, confidence: 0 } },
];

DEMO_FINDINGS.push(
  { id: "f5", title: "Hand-built low-cost water desalination still using waste heat", url: "https://example.org/demo/independent-desal", sourceId: "hn", publishedAt: d("2026-10-18"), fetchedAt: d("2026-10-30"), sector: "Water", maturity: "prototype",
    creator: "independent", track: "frontier", visibility: "low", benefit: 5, claimStatus: "speculative",
    evidence: "Inventor's public write-up reports bench output figures; not independently tested.", gap: "No third-party validation or durability data.", idea: "Community-scale kit with open test protocol to validate claims.", priorArt: "Solar stills are well known; waste-heat coupling at this cost unclear.", scores: { novelty: 4, feasibility: 3, impact: 4, confidence: 2 } },
  { id: "f6", title: "Student team: open-source prosthetic grip controller", url: "https://github.com/demo/student-grip", sourceId: "github", publishedAt: d("2026-10-05"), fetchedAt: d("2026-10-30"), sector: "Health", maturity: "prototype",
    creator: "student", track: "frontier", visibility: "low", benefit: 5, claimStatus: "reported",
    evidence: "Repository includes schematics, MIT license and demo video link.", gap: "No clinical evaluation; limited sensor options.", idea: "Partner with clinics for supervised user trials; keep designs open.", priorArt: "Commercial myoelectric hands exist at much higher cost.", scores: { novelty: 3, feasibility: 4, impact: 5, confidence: 3 } },
  { id: "f7", title: "Small lab: enzyme that breaks down mixed textile fibres", url: "https://arxiv.org/abs/demo.0007", sourceId: "arxiv", publishedAt: d("2026-10-22"), fetchedAt: d("2026-10-30"), sector: "Materials", maturity: "research",
    creator: "small-lab", track: "frontier", visibility: "low", benefit: 4, claimStatus: "reported",
    evidence: "Preprint (not peer-reviewed) reports partial depolymerisation in lab conditions.", gap: "Scale-up and enzyme stability unknown.", idea: "Pilot sorting-free textile recycling module.", priorArt: "PET-degrading enzymes known; mixed-fibre performance less studied.", scores: { novelty: 5, feasibility: 3, impact: 4, confidence: 2 } },
  { id: "f8", title: "Vendor update: faster managed vector database tier", url: "https://example.com/demo/vector-db", sourceId: "hn", publishedAt: d("2026-10-27"), fetchedAt: d("2026-10-30"), sector: "AI", maturity: "commercial",
    creator: "corporate", track: "commercial", visibility: "high", benefit: 2, claimStatus: "validated",
    evidence: "Vendor release notes list new tier and benchmarks.", gap: "Cost optimisation for small teams.", idea: "Usage-based cost advisor using authorized aggregated JAX feedback.", priorArt: "Many cost tools exist.", scores: { novelty: 2, feasibility: 5, impact: 3, confidence: 4 } },
);

export type Alert = { id: string; sector: string; minScore: number };
export type DiscoveryState = {
  optIn: boolean;
  sources: Record<string, boolean>;
  schedule: "off" | "daily" | "weekly";
  saved: string[];
  alerts: Alert[];
  lastScan: string | null;
  frontierShare: number; // % of ranked slots reserved for frontier/underdog track
  gemsOnly: boolean;
};

const KEY = "jackboy:discovery:v1";
const initial: DiscoveryState = {
  optIn: false, sources: Object.fromEntries(SOURCES.map((s) => [s.id, s.enabled])),
  schedule: "off", saved: [], alerts: [], lastScan: null, frontierShare: 40, gemsOnly: false,
};
let state = initial; let loaded = false;
const ls = new Set<() => void>();
function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try { const r = localStorage.getItem(KEY); if (r) state = { ...initial, ...JSON.parse(r) }; } catch { /* ignore */ }
}
export function setDiscovery(fn: (s: DiscoveryState) => DiscoveryState, message?: string) {
  load(); state = fn(state);
  if (typeof window !== "undefined") localStorage.setItem(KEY, JSON.stringify(state));
  ls.forEach((l) => l());
  if (message) log("info", `Discovery: ${message}`);
}
export function useDiscovery() {
  return useSyncExternalStore(
    (l) => { ls.add(l); if (!loaded) { load(); queueMicrotask(l); } return () => ls.delete(l); },
    () => state, () => initial,
  );
}

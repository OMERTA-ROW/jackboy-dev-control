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
};

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

export type Alert = { id: string; sector: string; minScore: number };
export type DiscoveryState = {
  optIn: boolean;
  sources: Record<string, boolean>;
  schedule: "off" | "daily" | "weekly";
  saved: string[];
  alerts: Alert[];
  lastScan: string | null;
};

const KEY = "jackboy:discovery:v1";
const initial: DiscoveryState = {
  optIn: false, sources: Object.fromEntries(SOURCES.map((s) => [s.id, s.enabled])),
  schedule: "off", saved: [], alerts: [], lastScan: null,
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

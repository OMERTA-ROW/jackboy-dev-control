import { z } from "zod";

/**
 * RA'SUL (Razul) — OMNI's public-intelligence & historical knowledge agent.
 * Proposed contract `razul.findings/v1` (unverified until Razul's real API is tested):
 *   GET  {RAZUL_API_URL}/v1/search?q=…&limit=…   GET {RAZUL_API_URL}/v1/feed?since=ISO
 *   POST {RAZUL_API_URL}/v1/feedback             Authorization: Bearer {RAZUL_API_KEY}
 */
export const EVIDENCE = ["verified", "peer_reviewed", "primary_source", "reported", "hypothesis", "historical"] as const;
export type Evidence = (typeof EVIDENCE)[number];

const raw = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(3).max(300),
  summary: z.string().max(4000).default(""),
  field: z.string().max(80).default("general"),
  evidence: z.enum(EVIDENCE),
  observed_at: z.string().datetime({ offset: true }),
  sources: z.array(z.object({ url: z.string().url().max(500), title: z.string().max(300).optional() })).min(1).max(20),
  confidence: z.number().min(0).max(1).optional(),
});
export type RazulFinding = z.infer<typeof raw>;

/** Never invents sources: findings without ≥1 http(s) source URL, a timestamp and an evidence class are dropped. */
export function normalizeFindings(payload: unknown): { findings: RazulFinding[]; dropped: number } {
  const list = Array.isArray(payload) ? payload : Array.isArray((payload as { findings?: unknown })?.findings) ? (payload as { findings: unknown[] }).findings : [];
  const findings: RazulFinding[] = [];
  for (const item of list) {
    const p = raw.safeParse(item);
    if (p.success && p.data.sources.every((s) => /^https?:\/\//.test(s.url))) findings.push(p.data);
  }
  return { findings, dropped: list.length - findings.length };
}

const EV_WEIGHT: Record<Evidence, number> = { verified: 40, peer_reviewed: 35, primary_source: 30, historical: 20, reported: 15, hypothesis: 5 };
/** 0-100. Evidence strength + confidence + multiple independent sources. Hypotheses can never outrank verified work by confidence alone. */
export function findingPriority(f: Pick<RazulFinding, "evidence" | "confidence" | "sources">) {
  const hosts = new Set(f.sources.map((s) => new URL(s.url).hostname)).size;
  return Math.min(100, EV_WEIGHT[f.evidence] + Math.round((f.confidence ?? 0.5) * 30) + Math.min(30, (hosts - 1) * 10));
}
export const isSpeculative = (e: Evidence) => e === "hypothesis" || e === "reported";

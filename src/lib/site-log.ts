// Site log + research pure rules (tested in site-log.test.ts).

/** Strips credentials and personal data before anything is logged or delivered. */
export function redact(s: string): string {
  return s
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted-token]")
    .replace(/\b(sk|pk|rk|sb_secret|sb_publishable|lovc)_[A-Za-z0-9_-]{12,}\b/g, "[redacted-key]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[redacted-jwt]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]");
}

/** Permissive licenses whose code may be adapted with attribution. Anything else is reference-only. */
export const PERMISSIVE = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense", "CC0-1.0"];
export function licenseAllowed(spdx: string | null | undefined): boolean {
  return !!spdx && PERMISSIVE.includes(spdx);
}

/** Relevance/quality score 0–100. Never penalizes small projects for low stars beyond a small weight. */
export function scorePattern(x: { licenseOk: boolean; archived: boolean; daysSincePush: number; stars: number; pathMatches: boolean }): number {
  if (x.archived) return 0;
  let s = x.licenseOk ? 40 : 10;
  s += x.pathMatches ? 25 : 0;
  s += x.daysSincePush < 180 ? 20 : x.daysSincePush < 730 ? 10 : 0;
  s += Math.min(15, Math.round(Math.log10(1 + x.stars) * 5));
  return Math.min(100, s);
}

export type Target = "razul" | "omni" | "jax";
export const TARGET_ENV: Record<Target, { url: string; key: string; label: string }> = {
  razul: { url: "RAZUL_API_URL", key: "RAZUL_API_KEY", label: "RA'SUL monitor" },
  omni: { url: "OMNI_API_URL", key: "OMNI_API_KEY", label: "OMNI Mothership" },
  jax: { url: "JAX_API_URL", key: "JAX_API_KEY", label: "JAX analytics" },
};

/** Retry gaps for failed deliveries: 1 min, 4, 16 … capped at 12 h. Unconfigured targets just wait. */
export function deliveryBackoffMs(attempts: number): number {
  return Math.min(12 * 3600_000, 60_000 * 4 ** Math.max(0, attempts - 1));
}

export function toCsv(rows: Record<string, unknown>[], cols: string[]): string {
  const esc = (v: unknown) => { const t = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

// Pure rules for site address monitoring. A public HTTP response proves reachability only, never coding access.

export type SiteStatus = "needs_address" | "checking" | "connected" | "unreachable" | "auth_needed" | "error";
export const SITE_LABEL: Record<SiteStatus, string> = {
  needs_address: "Needs site address", checking: "Checking", connected: "Site connected",
  unreachable: "Site unreachable", auth_needed: "Authorization needed", error: "Connection error",
};
export const SITE_TONE: Record<SiteStatus, "ok" | "warn" | "error" | "muted"> = {
  needs_address: "muted", checking: "muted", connected: "ok", unreachable: "error", auth_needed: "warn", error: "error",
};

export type UrlCheck = { ok: true; url: string; host: string } | { ok: false; reason: string };
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$)/i;
/** Accepts a bare domain or https URL; refuses non-https, credentials in URL and private/internal hosts. */
export function validateSiteUrl(input: string | null | undefined): UrlCheck {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, reason: "No site address set." };
  let u: URL;
  try { u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return { ok: false, reason: "Not a valid web address." }; }
  if (u.protocol !== "https:") return { ok: false, reason: "Site address must use https://." };
  if (u.username || u.password) return { ok: false, reason: "Remove the username/password from the address." };
  if (PRIVATE_HOST.test(u.hostname) || !u.hostname.includes(".")) return { ok: false, reason: "Address must be a public domain." };
  return { ok: true, url: u.toString(), host: u.hostname };
}

export type Probe = { dns: { ok: boolean; addresses: string[]; error?: string }; http?: { status: number; ms: number; finalUrl: string } | { error: string; ms: number } };
/** Status from real probe evidence only. */
export function classify(p: Probe): { status: SiteStatus; reason: string } {
  if (!p.dns.ok) return { status: "unreachable", reason: p.dns.error ?? "Domain does not resolve." };
  if (!p.http) return { status: "error", reason: "No HTTPS check was made." };
  if ("error" in p.http) return { status: /timed? ?out|abort/i.test(p.http.error) ? "unreachable" : "error", reason: p.http.error };
  const s = p.http.status;
  if (s === 401 || s === 403) return { status: "auth_needed", reason: `Site answered ${s}: it requires sign-in or blocks automated checks.` };
  if (s >= 500) return { status: "unreachable", reason: `Site answered ${s} (server error).` };
  if (s === 404) return { status: "error", reason: "Site answered 404: nothing is published at this address." };
  return { status: "connected", reason: `HTTPS ${s} in ${p.http.ms} ms. Public reachability only; coding access is checked separately.` };
}

const MIN = 60_000;
/** Next check: every 6 h while healthy; failures back off 15 min, 30, 60 … up to 12 h. */
export function nextCheckDelay(status: SiteStatus, failCount: number): number {
  if (status === "connected") return 6 * 60 * MIN;
  if (status === "needs_address") return Number.POSITIVE_INFINITY;
  return Math.min(15 * MIN * 2 ** Math.max(0, failCount - 1), 12 * 60 * MIN);
}

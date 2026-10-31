// Pure, client-safe policy for the server-side research connector. Enforced on the server.

export const SEARCH_TIMEOUT_MS = 8000;
export const RATE_LIMIT_PER_MINUTE = 6;
export const RATE_LIMIT_PER_DAY = 100;
export const MAX_QUERY_LENGTH = 200;
export const MAX_RESULTS = 10;

/** Reputable public research domains. Results outside this list are dropped. */
export const ALLOWED_DOMAINS = [
  "arxiv.org", "nature.com", "science.org", "ieee.org", "acm.org", "springer.com",
  "sciencedirect.com", "plos.org", "pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov", "biorxiv.org",
  "nist.gov", "nasa.gov", "energy.gov", "nsf.gov", "europa.eu", "w3.org", "ietf.org", "iso.org",
  "patents.google.com", "uspto.gov", "epo.org", "wipo.int",
  "github.com", "gitlab.com", "huggingface.co",
  "mit.edu", "stanford.edu", "berkeley.edu", "cam.ac.uk", "ox.ac.uk", "ethz.ch",
  "technologyreview.com", "spectrum.ieee.org", "arstechnica.com", "reuters.com",
] as const;

export function hostAllowed(url: string, allow: readonly string[] = ALLOWED_DOMAINS): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return allow.some((d) => host === d || host.endsWith(`.${d}`));
}

export type QueryCheck = { ok: true; query: string } | { ok: false; reason: string };

export function validateQuery(raw: unknown): QueryCheck {
  if (typeof raw !== "string") return { ok: false, reason: "Query must be text." };
  const q = raw.replace(/\s+/g, " ").trim();
  if (q.length < 2) return { ok: false, reason: "Query is too short." };
  if (q.length > MAX_QUERY_LENGTH) return { ok: false, reason: `Query must be under ${MAX_QUERY_LENGTH} characters.` };
  // Block attempts to reach private/credentialed content through search operators.
  if (/\b(inurl|intitle):.*(login|admin|password|token)/i.test(q) || /filetype:(env|pem|key|sql)/i.test(q))
    return { ok: false, reason: "Query targets private or credential content and is not allowed." };
  return { ok: true, query: q };
}

export function rateLimitStatus(lastMinute: number, lastDay: number): { allowed: boolean; reason?: string } {
  if (lastMinute >= RATE_LIMIT_PER_MINUTE) return { allowed: false, reason: `Limit of ${RATE_LIMIT_PER_MINUTE} searches per minute reached.` };
  if (lastDay >= RATE_LIMIT_PER_DAY) return { allowed: false, reason: `Daily limit of ${RATE_LIMIT_PER_DAY} searches reached.` };
  return { allowed: true };
}

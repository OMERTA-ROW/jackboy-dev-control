// Pure rules for naming WHICH OMNI link check refused a request. Never carries values:
// only fixed check labels, setting NAMES to compare, header shape labels and clock skew seconds.
export type DenialCheck =
  | "token_format"
  | "client_id"
  | "timestamp_format"
  | "clock_skew"
  | "nonce_format"
  | "signature"
  | "bootstrap_key"
  | "project"
  | "session"
  | "grant"
  | "replay"
  | "other";

export type DenialFacts = {
  check: DenialCheck;
  reason: string; // fixed protocol error code returned to OMNI
  http: number;
  skewSeconds: number | null; // Jackboy clock minus OMNI timestamp; null if unreadable
  action?: string | null; // only an allow-listed action name
  authHeader?: "missing" | "not_bearer" | "bad_token_format";
  clientHeader?: "missing" | "mismatch" | "case_only";
};

const ACTIONS = ["handshake", "submit", "status", "run", "cancel"];
const REASONS = /^[a-z_]{1,40}$/;

const INFO: Record<DenialCheck, { label: string; compare: string[] }> = {
  token_format: { label: "the Authorization token was missing or malformed", compare: ["OMNI_LINK_BOOTSTRAP_KEY"] },
  client_id: { label: "the client ID did not match", compare: ["OMNI_LINK_CLIENT_ID"] },
  timestamp_format: { label: "OMNI's request timestamp was missing or malformed", compare: [] },
  clock_skew: { label: "the clocks differ by more than 60 seconds", compare: [] },
  nonce_format: { label: "OMNI's request nonce was missing or malformed", compare: [] },
  signature: { label: "the signature did not match", compare: ["OMNI_LINK_HMAC_SECRET"] },
  bootstrap_key: { label: "the bootstrap key did not match", compare: ["OMNI_LINK_BOOTSTRAP_KEY"] },
  project: { label: "the project ID did not match", compare: ["OMNI_LINK_PROJECT_ID"] },
  session: { label: "the session was expired or unknown (reconnect with a fresh handshake)", compare: [] },
  grant: { label: "the owner approval, project or Kill Switch blocked it", compare: ["OMNI_LINK_OWNER_ID"] },
  replay: { label: "a request nonce was reused", compare: [] },
  other: { label: "another protocol rule refused it", compare: [] },
};

/** Maps a store/handler error code to a check when the handler did not name one directly. */
export function checkForReason(reason: string): DenialCheck {
  if (reason === "project_denied") return "project";
  if (reason === "session_expired_or_invalid") return "session";
  if (reason === "grant_unavailable") return "grant";
  if (reason === "replay") return "replay";
  return "other";
}

export function compareNames(check: DenialCheck): string[] {
  return [...INFO[check].compare];
}

/** One-line Site Log summary. Contains only fixed text, setting names and the skew number. */
export function denialSummary(f: DenialFacts): string {
  const info = INFO[f.check];
  const compare = info.compare.length ? ` Compare ${info.compare.join(", ")} between Jackboy and Railway (names only).` : "";
  const skew = f.skewSeconds === null ? " Clock difference unknown." : ` Clock difference ${f.skewSeconds}s.`;
  return `OMNI link refused (${f.check}): ${info.label}.${compare}${skew}`;
}

/** Value-free detail object for the Site Log; drops anything not on the fixed label lists. */
export function denialDetail(f: DenialFacts): Record<string, unknown> {
  return {
    check: f.check,
    reason: REASONS.test(f.reason) ? f.reason : "other",
    http: Number.isInteger(f.http) ? f.http : null,
    compare: compareNames(f.check),
    skewSeconds: typeof f.skewSeconds === "number" && Number.isFinite(f.skewSeconds) ? Math.round(f.skewSeconds) : null,
    action: f.action && ACTIONS.includes(f.action) ? f.action : null,
    ...(f.authHeader ? { authHeader: f.authHeader } : {}),
    ...(f.clientHeader ? { clientHeader: f.clientHeader } : {}),
  };
}

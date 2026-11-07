// Readiness for the reviewed OMNI-initiated link (omni.link/v2): OMNI calls Jackboy at
// /api/public/omni/link. Reports variable NAMES only, never values.
export const REVERSE_LINK_VARS = [
  "OMNI_LINK_ENABLED",
  "OMNI_LINK_CLIENT_ID",
  "OMNI_LINK_PROJECT_ID",
  "OMNI_LINK_OWNER_ID",
  "OMNI_LINK_APPROVAL_ID",
  "OMNI_LINK_APPROVAL_EXPIRES_AT",
  "OMNI_LINK_BOOTSTRAP_KEY",
  "OMNI_LINK_HMAC_SECRET",
] as const;

export type ReverseLinkReport = {
  direction: "omni-initiated";
  contract: "omni.link/v2";
  verified: boolean;
  missing: string[];
  steps: { name: string; ok: boolean; detail: string }[];
};

export function reverseLinkReport(input: {
  env: Record<string, string | undefined>;
  configValid: boolean;
  storageReady: boolean;
  lastSessionAt: string | null;
  now?: number;
  /** "local" Node runner, "remote" stateless runner, or "none"; omitted = not reported. */
  runner?: "local" | "remote" | "none";
}): ReverseLinkReport {
  const missingVars = REVERSE_LINK_VARS.filter((n) => !input.env[n]);
  const enabledFlag = input.env["OMNI_LINK_ENABLED"] === "true";
  const sessionExpiry = input.lastSessionAt ? Date.parse(input.lastSessionAt) : NaN;
  const activeSession = Number.isFinite(sessionExpiry) && sessionExpiry > (input.now ?? Date.now());
  const steps = [
    {
      name: "Jackboy link settings",
      ok: missingVars.length === 0 && enabledFlag && input.configValid,
      detail: missingVars.length
        ? `Missing on Jackboy: ${missingVars.join(", ")}`
        : !enabledFlag
          ? "OMNI_LINK_ENABLED must be exactly true"
          : input.configValid
            ? "All link settings present and valid"
            : "Settings present but invalid (UUIDs, expiry within 24h, 32+ char distinct keys)",
    },
    {
      name: "Jackboy link storage",
      ok: input.storageReady,
      detail: input.storageReady ? "Session-table read succeeded" : "Session storage could not be verified; check migration 0030_omni_sessions.sql and database access",
    },
    {
      name: "Unexpired OMNI session",
      ok: activeSession,
      detail: input.lastSessionAt
        ? activeSession ? `Session expires ${input.lastSessionAt}; live bridge reachability not tested` : "Last recorded OMNI session expired or has an invalid expiry; a fresh handshake is required"
        : "No OMNI-initiated session recorded yet; OMNI must call /api/public/omni/link",
    },
  ];
  if (input.runner)
    steps.push({
      name: "Self-test runner",
      ok: input.runner !== "none",
      detail:
        input.runner === "local"
          ? "Local Node runner enabled"
          : input.runner === "remote"
            ? "Remote runner configured; reachability is proven only by a real omni-link run"
            : "No runner: set OMNI_LINK_REMOTE_RUNNER_ENABLED/_URL/_SECRET, or submit/run returns runner_unavailable",
    });
  const missing = steps.filter((s) => !s.ok).map((s) => s.detail);
  return { direction: "omni-initiated", contract: "omni.link/v2", verified: missing.length === 0, missing, steps };
}

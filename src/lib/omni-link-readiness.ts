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
}): ReverseLinkReport {
  const missingVars = REVERSE_LINK_VARS.filter((n) => !input.env[n]);
  const enabledFlag = input.env["OMNI_LINK_ENABLED"] === "true";
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
      detail: input.storageReady ? "Session tables are installed" : "Migration 0030_omni_sessions.sql is not applied",
    },
    {
      name: "OMNI has connected",
      ok: !!input.lastSessionAt,
      detail: input.lastSessionAt
        ? `Last OMNI session issued (expires ${input.lastSessionAt})`
        : "No OMNI-initiated session recorded yet; OMNI must call /api/public/omni/link",
    },
  ];
  const missing = steps.filter((s) => !s.ok).map((s) => s.detail);
  return { direction: "omni-initiated", contract: "omni.link/v2", verified: missing.length === 0, missing, steps };
}

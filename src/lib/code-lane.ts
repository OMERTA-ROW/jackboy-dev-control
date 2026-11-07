// Two approval lanes for CODE runs. Pure rules; the server is the only authority on the lane.
// "reviewed" = today's CODE / CODE-PUBLISH environments with your GitHub approval.
// "auto" = CODE-AUTO / CODE-PUBLISH-AUTO without a reviewer, for small low-risk runs only.

export type Lane = "reviewed" | "auto";
export const LANE_ENV = {
  reviewed: { execute: "CODE", publish: "CODE-PUBLISH" },
  auto: { execute: "CODE-AUTO", publish: "CODE-PUBLISH-AUTO" },
} as const;
export const AUTO_ENVS = [LANE_ENV.auto.execute, LANE_ENV.auto.publish] as const;

export const AUTO_MAX_FILES = 3;
export const AUTO_MAX_LINES = 50;
export const AUTO_RUNS_PER_SITE_PER_DAY = 3;
export const AUTO_HOLD_USD = 1;

/** Passkey target for the per-site switch: one site, one direction. */
export const autoLaneTarget = (repo: string, on: boolean) => `code_auto_lane:${repo}:${on ? "on" : "off"}`;

/** The stored lane only counts as automatic when it is exactly "auto"; anything else is reviewed. */
export function laneOf(scope: { lane?: unknown } | null | undefined): Lane {
  return scope?.lane === "auto" ? "auto" : "reviewed";
}

/** The environment a runner's signed GitHub identity must name, per stage and lane. Finish has none. */
export function expectedEnvironment(stage: "execute" | "publish" | "finish", lane: Lane): string | undefined {
  if (stage === "finish") return undefined;
  return LANE_ENV[lane][stage];
}
export function expectedSubject(repo: string, stage: "execute" | "publish" | "finish", lane: Lane, ref: string): string {
  const env = expectedEnvironment(stage, lane);
  return env ? `repo:${repo}:environment:${env}` : `repo:${repo}:ref:refs/heads/${ref}`;
}

/** Paths an automatic run may never touch. Unknown means reviewed, so this list only ever grows. */
const PROTECTED: RegExp[] = [
  /^\.github\//, /(^|\/)\.env(\.|$)/, /(^|\/)(supabase|drizzle|migrations?)\//, /\.sql$/i,
  /(^|\/)(package\.json|package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|go\.mod|go\.sum|Dockerfile)$/,
  /(^|\/)(auth|passkey|webauthn|permissions?|roles?|step-up|session)[^/]*$/i, /(^|\/)(auth|passkey|webauthn)\//i,
  /(pay|payment|billing|stripe|paddle|checkout)/i,
  /(^|\/)(code[-.]|code\.server|code-safety|code-lane|code-runner|code-gateway|guidelines)/i,
  /(^|\/)scripts\/code-/, /(^|\/)src\/integrations\//, /(secret|credential|token|private[-_]?key)/i,
  /(^|\/)(wrangler\.(toml|jsonc?)|railway\.json|vite\.config\.[cm]?[jt]s)$/,
];
export function protectedPath(path: string): boolean {
  return PROTECTED.some((r) => r.test(path));
}

export type PatchFile = { path: string; status: string; additions: number; deletions: number };
export type PatchEvidence = { files: PatchFile[]; fileCount?: number };
/** Re-check of the ACTUAL patch. Low-risk only when small, nothing deleted or renamed, no protected path, and the report is complete. */
export function classifyPatch(p: PatchEvidence | null | undefined): { lowRisk: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!p || !Array.isArray(p.files)) return { lowRisk: false, reasons: ["No patch report."] };
  const count = typeof p.fileCount === "number" ? p.fileCount : p.files.length;
  if (count !== p.files.length) reasons.push("The patch report is incomplete.");
  if (count === 0) reasons.push("The patch is empty.");
  if (count > AUTO_MAX_FILES) reasons.push(`Changes ${count} files (automatic limit ${AUTO_MAX_FILES}).`);
  let lines = 0;
  for (const f of p.files) {
    if (typeof f.path !== "string" || !f.path || f.path.includes("..") || f.path.startsWith("/")) { reasons.push("A changed path is invalid."); continue; }
    if (!Number.isInteger(f.additions) || !Number.isInteger(f.deletions) || f.additions < 0 || f.deletions < 0) { reasons.push(`${f.path}: line counts are invalid.`); continue; }
    lines += f.additions + f.deletions;
    if (f.status !== "modified" && f.status !== "added") reasons.push(`${f.path}: ${f.status || "unknown"} files need review.`);
    if (protectedPath(f.path)) reasons.push(`${f.path} is a protected path.`);
  }
  if (lines > AUTO_MAX_LINES) reasons.push(`Changes ${lines} lines (automatic limit ${AUTO_MAX_LINES}).`);
  return { lowRisk: reasons.length === 0, reasons };
}

/** Words in a request that always mean the reviewed lane. */
const RISKY_WORDS = /\b(migrat|schema|database|secret|credential|token|password|key|auth|login|sign[- ]?in|passkey|permission|role|payment|billing|stripe|checkout|deploy|publish|release|merge|delete|remove|drop|workflow|github action|dependenc|upgrade|install|package|env)\w*/i;

export type RequestFacts = {
  instruction: string; siteAutoEnabled: boolean; killSwitch: boolean; failureStop: boolean;
  autoRunsToday: number; holdUsd: number; spendBlocked: string | null;
};
/** Lane chosen BEFORE dispatch. Every condition must hold; the reasons explain each refusal. */
export function chooseLane(f: RequestFacts): { lane: Lane; reasons: string[] } {
  const reasons: string[] = [];
  if (!f.siteAutoEnabled) reasons.push("Automatic lane is off for this site.");
  if (f.killSwitch) reasons.push("Kill Switch is on.");
  if (f.failureStop) reasons.push("This site is in a two-failure stop.");
  if (f.autoRunsToday >= AUTO_RUNS_PER_SITE_PER_DAY) reasons.push(`Already ${f.autoRunsToday} automatic runs today (limit ${AUTO_RUNS_PER_SITE_PER_DAY}).`);
  if (!(f.holdUsd > 0 && f.holdUsd <= AUTO_HOLD_USD)) reasons.push(`The run's hold must be at most $${AUTO_HOLD_USD}.`);
  if (f.spendBlocked) reasons.push(f.spendBlocked);
  const risky = f.instruction.match(RISKY_WORDS);
  if (risky) reasons.push(`The request mentions "${risky[0]}", which always needs review.`);
  if (f.instruction.trim().length > 600) reasons.push("Long requests need review.");
  return { lane: reasons.length ? "reviewed" : "auto", reasons };
}

/** Trial label: what the lane WOULD be if the site's switch were on (the switch itself is ignored). */
export function trialLane(f: RequestFacts): { wouldAuto: boolean; reasons: string[] } {
  const r = chooseLane({ ...f, siteAutoEnabled: true });
  return { wouldAuto: r.lane === "auto", reasons: r.reasons };
}

export type EnvBody = {
  protection_rules?: { type: string; reviewers?: unknown[] }[];
  deployment_branch_policy?: { protected_branches: boolean; custom_branch_policies: boolean } | null;
} | null;
/** Read-only check of an automatic environment: exists, main-only branches, no secrets or variables. Reviewers are allowed but defeat the purpose. */
export function autoEnvProblems(env: EnvBody, branches: string[] | null, secrets: number | null, variables: number | null): string[] {
  if (!env) return ["Not created yet."];
  const out: string[] = [];
  const bp = env.deployment_branch_policy;
  if (!bp || !bp.custom_branch_policies) out.push('Deployment branches must be "Selected branches and tags" with only main.');
  else if (branches === null) out.push("Couldn't read the branch rules.");
  else if (branches.length !== 1 || branches[0] !== "main") out.push(`Branch rules must be exactly "main" (found ${branches.join(", ") || "none"}).`);
  if (secrets === null) out.push("Couldn't read whether it has secrets.");
  else if (secrets > 0) out.push(`Has ${secrets} environment secret(s); it must have none.`);
  if (variables === null) out.push("Couldn't read whether it has variables.");
  else if (variables > 0) out.push(`Has ${variables} environment variable(s); it must have none.`);
  if (env.protection_rules?.some((r) => r.type === "required_reviewers")) out.push("Has required reviewers, so runs would still wait for you.");
  return out;
}

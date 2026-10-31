/** Owner-controlled automation policy for the Jackboy → OMNI → Guardian workflow. Pure rules, unit-tested. */

export const LEARNING_KINDS = ["diagnostic", "patch_diff", "test_result", "guardian_verdict", "deployment", "rollback", "feedback"] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];

/** Categories that ALWAYS need the owner, at every tier. */
export const HIGH_RISK = ["auth", "security", "payment", "data", "production", "secrets", "permissions", "infra"] as const;

export const TIERS = [
  { tier: 0, name: "Owner approves everything", detail: "Default. Every merge and deployment needs the owner." },
  { tier: 1, name: "Guardian: tiny low-risk merges", detail: "Guardian may approve narrowly scoped, low-risk merges to non-production branches. Deploys still need the owner." },
  { tier: 2, name: "Guardian: low-risk merges + staging deploys", detail: "Adds staging deployments of already Guardian-approved low-risk changes. Production always needs the owner." },
] as const;

export type Policy = { tier: 0 | 1 | 2; paused: boolean; guardianVerified: boolean; maxFiles: number; maxLines: number };
export type Change = {
  action: "merge" | "deploy_staging" | "deploy_production";
  categories: string[];
  filesChanged: number;
  linesChanged: number;
  testsPassed: boolean;
  branchProtected: boolean;
  rollbackPlan: boolean;
  guardianVerdict: "pass" | "fail" | "none";
};
export type Decision = { route: "blocked" | "owner" | "guardian"; reasons: string[] };

export function routeApproval(c: Change, p: Policy): Decision {
  if (p.paused) return { route: "blocked", reasons: ["Automation is paused by the owner."] };
  const why: string[] = [];
  const high = c.categories.filter((x) => (HIGH_RISK as readonly string[]).includes(x));
  if (high.length) why.push(`High-risk area: ${high.join(", ")}.`);
  if (c.action === "deploy_production") why.push("Production deployment.");
  if (p.tier === 0) why.push("Policy tier 0: owner approves everything.");
  if (c.action === "deploy_staging" && p.tier < 2) why.push("Staging deploys need tier 2.");
  if (!p.guardianVerified) why.push("Guardian integration not verified.");
  if (c.guardianVerdict !== "pass") why.push("No passing Guardian verdict.");
  if (!c.testsPassed) why.push("Tests have not passed.");
  if (!c.branchProtected) why.push("Branch protection not confirmed.");
  if (!c.rollbackPlan) why.push("No rollback plan.");
  if (c.filesChanged > p.maxFiles || c.linesChanged > p.maxLines) why.push(`Change exceeds scope (${p.maxFiles} files / ${p.maxLines} lines).`);
  return why.length ? { route: "owner", reasons: why } : { route: "guardian", reasons: ["All low-risk conditions met."] };
}

/** Jackboy may dispatch work to OMNI on its own only when not paused and OMNI is verified. Nothing auto-merges. */
export function canDispatch(p: { paused: boolean }, omniVerified: boolean) {
  if (p.paused) return { ok: false, reason: "Automation is paused." };
  if (!omniVerified) return { ok: false, reason: "OMNI is not connected/verified. Work is queued locally, not sent." };
  return { ok: true, reason: "Dispatch allowed." };
}

/** Retrieval only from owner-verified playbooks; never from raw private code. */
export function matchPlaybooks<T extends { verified: boolean; trigger: string; title: string }>(books: T[], query: string, limit = 3) {
  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  return books
    .filter((b) => b.verified)
    .map((b) => ({ b, score: terms.filter((t) => `${b.trigger} ${b.title}`.toLowerCase().includes(t)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.b);
}

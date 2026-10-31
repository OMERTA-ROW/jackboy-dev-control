import { z } from "zod";

/** AngelTech = diagnostics/research/code-quality. DemonTech = authorized DEFENSIVE security checks only. */
export const ANGEL_KINDS = ["diagnostic", "research", "code_quality", "health"] as const;
export const DEMON_CHECKS = ["dependency_audit", "secret_scan", "rls_review", "header_check", "config_review"] as const;
/** Never allowed for any agent: offensive or intrusive actions. */
export const FORBIDDEN_ACTIONS = ["exploit", "brute_force", "ddos", "credential_harvest", "port_scan_external", "malware", "phishing", "bypass_auth"] as const;

export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const ingestSchema = z.object({
  agent: z.enum(["angeltech", "demontech"]),
  kind: z.string().min(2).max(40),
  severity: z.enum(SEVERITIES),
  title: z.string().trim().min(3).max(200),
  detail: z.string().max(4000).default(""),
  source_url: z.string().url().max(500).optional(),
  health: z.enum(["ok", "degraded", "failing"]).optional(),
});
export type IngestPayload = z.infer<typeof ingestSchema>;

/** Validates agent/kind pairing; DemonTech may only submit allowlisted defensive checks. */
export function validateIngest(raw: unknown): { ok: true; data: IngestPayload } | { ok: false; reason: string } {
  const p = ingestSchema.safeParse(raw);
  if (!p.success) return { ok: false, reason: "Invalid payload: " + p.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ") };
  const d = p.data;
  if ((FORBIDDEN_ACTIONS as readonly string[]).includes(d.kind)) return { ok: false, reason: `Forbidden action "${d.kind}".` };
  if (d.agent === "angeltech" && !(ANGEL_KINDS as readonly string[]).includes(d.kind)) return { ok: false, reason: `AngelTech kind must be one of ${ANGEL_KINDS.join(", ")}.` };
  if (d.agent === "demontech" && !(DEMON_CHECKS as readonly string[]).includes(d.kind)) return { ok: false, reason: `DemonTech may only run defensive checks: ${DEMON_CHECKS.join(", ")}.` };
  return { ok: true, data: d };
}

const SEV_WEIGHT: Record<Severity, number> = { info: 0, low: 10, medium: 30, high: 60, critical: 90 };
/** Priority 0-100: severity first, security findings +10, aged open items creep up to +10. */
export function priorityScore(severity: Severity, agent: "angeltech" | "demontech", ageDays = 0) {
  return Math.min(100, SEV_WEIGHT[severity] + (agent === "demontech" ? 10 : 0) + Math.min(10, Math.floor(ageDays)));
}

/** Licenses whose code can be referenced/adapted with attribution. Anything else needs owner review. */
export const PERMISSIVE_LICENSES = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "CC0-1.0", "Unlicense", "CC-BY-4.0"] as const;
export const COPYLEFT_LICENSES = ["GPL-2.0", "GPL-3.0", "AGPL-3.0", "LGPL-2.1", "LGPL-3.0", "MPL-2.0", "CC-BY-SA-4.0"] as const;
export type ReuseVerdict = "reference_with_attribution" | "owner_review_required" | "do_not_copy";

/** Research reuse gate: no blind copying. Unknown/missing license = do not copy. */
export function reuseVerdict(license: string | null | undefined, attribution: string | null | undefined): ReuseVerdict {
  if (!license || !attribution?.trim()) return "do_not_copy";
  if ((PERMISSIVE_LICENSES as readonly string[]).includes(license)) return "reference_with_attribution";
  if ((COPYLEFT_LICENSES as readonly string[]).includes(license)) return "owner_review_required";
  return "do_not_copy";
}

export type ProposalAction = "open_pr" | "merge" | "deploy_production" | "sensitive_change";
/** Jackboy may open PRs from sandboxed proposals; merges, production deploys and sensitive changes need the owner. */
export function requiresOwnerApproval(action: ProposalAction) {
  return action !== "open_pr";
}
export function canPerform(action: ProposalAction, p: { status: string; testsPassed: boolean; approvedByOwner: boolean }) {
  if (!p.testsPassed) return false;
  if (action === "open_pr") return p.status !== "rejected";
  return p.approvedByOwner && p.status === "approved";
}

/** 32 random bytes, hex. Only the SHA-256 hash is stored server-side. */
export function newProjectToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return "jbk_" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
export async function hashProjectToken(token: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}
export const isWellFormedProjectToken = (t: string) => /^jbk_[0-9a-f]{64}$/.test(t);

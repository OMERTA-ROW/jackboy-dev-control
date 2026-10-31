/** "Give every agent its wings" — capability model + Guardian deny-by-default gate. Pure, unit-tested. */

export const CAPABILITIES = [
  { id: "discover", label: "Find tasks", risk: "low" },
  { id: "research", label: "Research public sources", risk: "low" },
  { id: "read_project", label: "Read its own project (read-only)", risk: "low" },
  { id: "propose", label: "Draft proposals", risk: "low" },
  { id: "experiment", label: "Run isolated sandbox tests", risk: "medium" },
  { id: "collaborate", label: "Message other agents", risk: "low" },
  { id: "feedback", label: "Send feedback reports", risk: "low" },
  { id: "adversarial_test", label: "Adversarial tests in sandbox only", risk: "medium" },
  { id: "deploy_production", label: "Production deployment", risk: "high" },
  { id: "transfer_private_data", label: "Private data transfer", risk: "high" },
  { id: "change_credentials", label: "Credential changes", risk: "high" },
  { id: "publish_external", label: "External publication", risk: "high" },
  { id: "high_impact", label: "Other high-impact action", risk: "high" },
] as const;
export type Capability = (typeof CAPABILITIES)[number]["id"];
export const OWNER_ONLY: Capability[] = CAPABILITIES.filter((c) => c.risk === "high").map((c) => c.id);

export const AUTONOMY = [
  { id: "observe", label: "Observe", detail: "Find tasks, research, read its own project, send feedback." },
  { id: "propose", label: "Propose", detail: "Adds drafting proposals and messaging other agents." },
  { id: "experiment", label: "Experiment", detail: "Adds isolated sandbox tests (and DemonTech sandbox adversarial tests)." },
] as const;
export type Autonomy = (typeof AUTONOMY)[number]["id"];

const BY_TIER: Record<Autonomy, Capability[]> = {
  observe: ["discover", "research", "read_project", "feedback"],
  propose: ["discover", "research", "read_project", "feedback", "propose", "collaborate"],
  experiment: ["discover", "research", "read_project", "feedback", "propose", "collaborate", "experiment", "adversarial_test"],
};

export type AgentCategory = "angeltech" | "demontech";
export function autonomousCapabilities(category: AgentCategory, tier: Autonomy): Capability[] {
  return BY_TIER[tier].filter((c) => c !== "adversarial_test" || category === "demontech");
}

/** Integration each capability depends on. Missing integration ⇒ deny. */
const NEEDS: Partial<Record<Capability, "sandbox" | "search" | "omni" | "repo">> = {
  research: "search", read_project: "repo", experiment: "sandbox", adversarial_test: "sandbox", deploy_production: "omni",
};

export type GuardianInput = {
  agent: { category: AgentCategory; autonomy: Autonomy; paused: boolean; installedVerified: boolean; passportApproved: boolean; projectId: string };
  action: Capability;
  targetProjectId: string;
  globalPaused: boolean;
  integrations: Partial<Record<"sandbox" | "search" | "omni" | "repo", boolean>>;
  ownerApproved?: boolean;
};
export type GuardianVerdict = { allow: boolean; needsOwner: boolean; reason: string };

/** Deny by default. Order matters: pauses and isolation first, then integration, then tier, then owner gate. */
export function guardianCheck(i: GuardianInput): GuardianVerdict {
  const deny = (reason: string, needsOwner = false): GuardianVerdict => ({ allow: false, needsOwner, reason });
  if (!CAPABILITIES.some((c) => c.id === i.action)) return deny("Unknown action.");
  if (i.globalPaused) return deny("Emergency pause is on.");
  if (i.agent.paused) return deny("This agent is paused.");
  if (!i.agent.passportApproved) return deny("Agent passport not approved by the owner.");
  if (!i.agent.installedVerified) return deny("Agent not verified as installed.");
  if (i.targetProjectId !== i.agent.projectId) return deny("Project isolation: agents may only act on their own project.");
  const need = NEEDS[i.action];
  if (need && !i.integrations[need]) return deny(`Required integration "${need}" is not connected.`);
  if (OWNER_ONLY.includes(i.action)) return i.ownerApproved ? { allow: true, needsOwner: true, reason: "Owner approved." } : deny("Owner approval required.", true);
  if (!autonomousCapabilities(i.agent.category, i.agent.autonomy).includes(i.action)) return deny(`Not allowed at "${i.agent.autonomy}" autonomy.`);
  return { allow: true, needsOwner: false, reason: "Within scope." };
}

export const ADAPTERS = [
  { id: "owner_agent", label: "Owner's existing agent (via OMNI)" },
  { id: "third_party", label: "Authorized third-party model" },
  { id: "local", label: "Local model" },
] as const;

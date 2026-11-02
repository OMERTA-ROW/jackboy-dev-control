// Shared agent manifest + capability registry (reference implementation: Jackboy).
// Any owner project can later publish the same shape so OMNI can coordinate and Guardian can check it.
// Status is never asserted: each capability's status comes from a live check result passed in.
import type { ToolRisk } from "./agent-contracts";

export const MANIFEST_VERSION = "owner-agent.manifest/v1";

export type CapStatus = "operational" | "blocked" | "not_built";
export type Capability = {
  id: string;
  label: string;          // plain words for users and voice
  risk: ToolRisk;
  status: CapStatus;
  detail: string;         // why, from the check (never a secret)
  fix?: string;           // what the owner can do to unblock
  tool?: string;          // chat tool that performs it, when operational
};
export type AgentManifest = {
  version: typeof MANIFEST_VERSION;
  agent: { id: string; name: string; role: string };
  generatedAt: string;
  capabilities: Capability[];
};

/** Inter-agent message envelope. Delivery must be authenticated (bearer or HMAC) and idempotent by `id`. */
export type AgentMessage = {
  id: string;                     // idempotency key
  from: string; to: string;       // agent ids, e.g. "jackboy" -> "omni"
  kind: "event" | "task_request" | "task_result";
  projectId: string | null;
  createdAt: string;
  body: Record<string, unknown>;  // redacted; never credentials
};

export type Checks = {
  code?: { verified: boolean; detail: string };
  ai: boolean;
  githubRepo: { ok: boolean; usable: number; error?: string };
  actionsRead: boolean | null;     // null = not checked
  projectsWithSite: number;
  voiceServer: boolean;            // transcription key present
  outboxTargets: number;           // configured log delivery targets
  omniVerified: boolean;
};

/** Build Jackboy's manifest from live check results. */
export function buildJackboyManifest(c: Checks, now = new Date()): AgentManifest {
  const cap = (x: Capability) => x;
  return {
    version: MANIFEST_VERSION,
    agent: { id: "jackboy", name: "Jackboy", role: "Code quality and repair agent for the owner's projects" },
    generatedAt: now.toISOString(),
    capabilities: [
      cap({ id: "code", label: "CODE development jobs", risk: "bounded", status: c.code?.verified ? "operational" : "blocked", detail: c.code?.detail ?? "No live CODE runner has been verified", fix: "Review CODE setup and complete an owner-approved live acceptance run" }),
      cap({ id: "chat", label: "Talk and answer questions about your projects", risk: "read", status: c.ai ? "operational" : "blocked", detail: c.ai ? "AI model reachable" : "AI model not reachable", ...(c.ai ? {} : { fix: "Check AI credits in Settings" }) }),
      cap({ id: "scan", label: "Scan project websites for broken links, errors and demo leftovers", risk: "bounded", tool: "scanSite", status: c.projectsWithSite > 0 ? "operational" : "blocked", detail: c.projectsWithSite > 0 ? `${c.projectsWithSite} project(s) have a site address; static HTML only, no JavaScript` : "No project has a site address", ...(c.projectsWithSite > 0 ? {} : { fix: "Add a site address under Projects → Manage" }) }),
      cap({ id: "repo_edit", label: "Read code and write fixes on a work branch", risk: "bounded", tool: "writeFile", status: c.githubRepo.ok && c.githubRepo.usable > 0 ? "operational" : "blocked", detail: c.githubRepo.ok ? `${c.githubRepo.usable} private repo(s) usable` : c.githubRepo.error ?? "GitHub not connected", ...(c.githubRepo.ok && c.githubRepo.usable > 0 ? {} : { fix: "Connect GitHub on the Connections page" }) }),
      cap({ id: "draft_pr", label: "Open draft pull requests for your review", risk: "bounded", tool: "openDraftPR", status: c.githubRepo.ok && c.githubRepo.usable > 0 ? "operational" : "blocked", detail: "Never merges", ...(c.githubRepo.ok ? {} : { fix: "Connect GitHub on the Connections page" }) }),
      cap({ id: "ci_results", label: "Read automated test results", risk: "read", tool: "checkStatus", status: c.actionsRead ? "operational" : "blocked", detail: c.actionsRead ? "GitHub Actions readable" : "GitHub token lacks Actions read permission", ...(c.actionsRead ? {} : { fix: "Give the GitHub token 'Actions: Read-only', then press Verify on AutoConnect" }) }),
      cap({ id: "run_tests", label: "Run tests and browser checks myself", risk: "bounded", status: "not_built", detail: "No isolated test or browser runner exists yet", fix: "Needs a sandbox runner (future)" }),
      cap({ id: "voice", label: "Voice conversation in chat", risk: "read", status: c.voiceServer ? "operational" : "blocked", detail: c.voiceServer ? "Browser speech, or server transcription fallback" : "Transcription not configured", }),
      cap({ id: "report_out", label: "Send activity reports to Razoo/OMNI", risk: "read", status: c.outboxTargets > 0 ? "operational" : "blocked", detail: c.outboxTargets > 0 ? `${c.outboxTargets} target(s) configured` : "Reports wait in the outbox; no target endpoint configured", ...(c.outboxTargets > 0 ? {} : { fix: "Provide a Razoo or OMNI endpoint" }) }),
      cap({ id: "omni_delegate", label: "Hand tasks to OMNI", risk: "bounded", status: c.omniVerified ? "operational" : "blocked", detail: c.omniVerified ? "OMNI verified" : "OMNI not connected; tasks stay queued", fix: "Connect OMNI with an authenticated endpoint" }),
      cap({ id: "deploy", label: "Merge or deploy to production", risk: "production", status: "not_built", detail: "Merge/revert need your passkey each time; Jackboy has no publish/deploy integration" }),
    ],
  };
}

export const missing = (m: AgentManifest) => m.capabilities.filter((c) => c.status !== "operational");

/** Next useful actions: operational fix-capable steps first, then the cheapest unblock. */
export function nextActions(m: AgentManifest): string[] {
  const out: string[] = [];
  const op = (id: string) => m.capabilities.find((c) => c.id === id)?.status === "operational";
  if (op("scan")) out.push("Scan selected projects and list issues");
  if (op("repo_edit") && op("draft_pr")) out.push("Write a fix for the top issue and open a draft pull request");
  const firstFix = missing(m).find((c) => c.fix && c.status === "blocked");
  if (firstFix) out.push(`Unblock: ${firstFix.fix}`);
  return out.slice(0, 3);
}


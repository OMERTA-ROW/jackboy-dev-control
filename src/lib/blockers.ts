// Blocker queue rules (pure; tested in blockers.test.ts). Blockers are derived from real stored state:
// projects, capability grants and Foundry tasks. Nothing here grants access — approval only unlocks a
// real verification, and only a passing verification clears a capability blocker.
import { capById, effectiveStatus, type CapStatus } from "./autoconnect";

export type Risk = "Routine" | "Controlled" | "Critical";
export type BlockerStatus = "needs_approval" | "owner_action" | "auto_checking" | "paused" | "unsupported";
export type BlockerAction = { kind: "approve" | "verify"; cap: string; passkey: boolean } | { kind: "link_repo" } | null;
export type Blocker = {
  id: string; projectId: string; projectName: string; cause: string; missing: string;
  remedy: string; risk: Risk; status: BlockerStatus; action: BlockerAction; waitingTasks: string[];
};

type Project = { id: string; name: string; github_repo: string | null; dev_enabled: boolean; active: boolean };
type GrantRow = { capability: string; project_id: string; status: CapStatus; paused: boolean; expires_at: string | null; last_error: string | null };
type Task = { id: string; project_id: string; title: string; state: string; needs_capability: string | null; blocked_reason: string | null };

/** Credential/permission scopes on external providers need passkey step-up; built-in services don't. */
export function capRisk(cap: string): Risk {
  if (cap === "github_repo" || cap === "github_actions_read" || cap === "deploy_api") return "Critical";
  if (cap === "model_provider") return "Routine";
  return "Controlled";
}

/** A project counts as connected only if the owner linked a repo or explicitly activated it. */
export const isConnected = (p: Project) => p.active && (!!p.github_repo || p.dev_enabled);

export function deriveBlockers(projects: Project[], grants: GrantRow[], tasks: Task[], now = Date.now()): Blocker[] {
  const out: Blocker[] = [];
  const byId = new Map(projects.map((p) => [p.id, p]));
  const waiting = (pid: string, cap: string) => tasks.filter((t) => t.project_id === pid && t.needs_capability === cap).map((t) => t.title);

  for (const p of projects) {
    if (isConnected(p) && !p.github_repo) out.push({
      id: `repo:${p.id}`, projectId: p.id, projectName: p.name,
      cause: "Jackboy is activated for this project but no repository is linked.",
      missing: "Linked private GitHub repository", remedy: "Open the project, add its private GitHub repo, then Jackboy verifies access automatically.",
      risk: "Controlled", status: "owner_action", action: { kind: "link_repo" }, waitingTasks: [],
    });
  }

  for (const g of grants) {
    const p = byId.get(g.project_id); if (!p || !isConnected(p)) continue;
    const c = capById(g.capability); if (!c) continue;
    const s = effectiveStatus(g, now);
    if (s === "connected") continue;
    const w = waiting(p.id, g.capability);
    const risk = capRisk(g.capability);
    const base = { id: `cap:${g.capability}:${p.id}`, projectId: p.id, projectName: p.name, missing: `${c.name} — ${c.scopes}`, risk, waitingTasks: w };
    if (s === "unavailable") { if (w.length) out.push({ ...base, cause: "A queued task needs this, but Jackboy has no supported connection for it yet.", remedy: c.steps.join(" "), status: "unsupported", action: null }); continue; }
    if (s === "revoked" && !w.length) continue; // owner deliberately revoked and nothing waits on it
    if (g.paused) { out.push({ ...base, cause: "You paused this connection.", remedy: "Resume it on AutoConnect when ready.", status: "paused", action: null }); continue; }
    if (s === "missing" || s === "needs_approval" || s === "revoked") {
      out.push({ ...base, cause: s === "revoked" ? "Access was revoked; waiting work cannot continue." : "Not approved yet, so Jackboy has never been allowed to check it.", remedy: `Approve this exact scope; Jackboy then runs a real check and continues waiting work. ${c.manual ? "You may also need to: " + c.steps.join(" ") : ""}`.trim(), status: "needs_approval", action: { kind: "approve", cap: g.capability, passkey: risk === "Critical" } });
      continue;
    }
    // awaiting_setup | error | expired: approved, but the provider check has not passed.
    out.push({ ...base, cause: g.last_error ?? (s === "expired" ? "Access expired." : "Approved, not yet verified."), remedy: c.manual ? c.steps.join(" ") : "Jackboy re-checks automatically.", status: c.manual ? "owner_action" : "auto_checking", action: { kind: "verify", cap: g.capability, passkey: false } });
  }

  for (const t of tasks) {
    const p = byId.get(t.project_id);
    if (!p || t.state !== "blocked" || t.needs_capability) continue;
    out.push({ id: `task:${t.id}`, projectId: p.id, projectName: p.name, cause: t.blocked_reason ?? "Task blocked.", missing: "Owner review of a blocked Code Foundry task", remedy: "Review it in Code Foundry: retry after fixing the cause, or reject it.", risk: "Controlled", status: "owner_action", action: null, waitingTasks: [t.title] });
  }

  const order: Record<BlockerStatus, number> = { needs_approval: 0, owner_action: 1, auto_checking: 2, paused: 3, unsupported: 4 };
  return out.sort((a, b) => order[a.status] - order[b.status] || b.waitingTasks.length - a.waitingTasks.length || a.projectName.localeCompare(b.projectName));
}

/** Passkey target binds the step-up to exactly one capability on one project. */
export const approvalTarget = (cap: string, projectId: string) => `${cap}:${projectId}`;

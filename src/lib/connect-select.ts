// Pure rules for the Connect page multi-select and the coding-loop status badge.
import { lovableUrl } from "./project-hub";

export type ConnectRow = {
  key: string;                 // "p:<owner_project id>" or "i:<inventory id>"
  name: string;
  projectId: string | null;    // set once connected
  lovableRef: string | null;
  repo: string | null;
  status: "saved_only" | "connected_no_repo" | "repo_linked" | "repo_error";
  detail: string;
};

type P = { id: string; name: string; github_repo: string | null; connect_state?: string | null; connect_error?: string | null; lovable_url?: string | null };
type I = { id: string; name: string; lovable_project_ref: string | null };

/** One row per project: connected ones first (truthful repo status), then saved-inventory items not yet connected. */
export function connectRows(projects: P[], inventory: I[]): ConnectRow[] {
  const rows: ConnectRow[] = projects.map((p) => {
    const err = p.connect_state === "error" || Boolean(p.connect_error);
    const status: ConnectRow["status"] = !p.github_repo ? "connected_no_repo" : err ? "repo_error" : "repo_linked";
    const detail = status === "connected_no_repo" ? "Connected, but no private GitHub repo — coding is blocked."
      : status === "repo_error" ? `Repo problem: ${p.connect_error ?? "check failed"}` : `Repo ${p.github_repo}`;
    return { key: `p:${p.id}`, name: p.name, projectId: p.id, lovableRef: null, repo: p.github_repo, status, detail };
  });
  const taken = new Set(projects.map((p) => p.name.trim().toLowerCase()));
  for (const i of inventory) {
    if (taken.has(i.name.trim().toLowerCase())) continue;
    rows.push({ key: `i:${i.id}`, name: i.name, projectId: null, lovableRef: i.lovable_project_ref, repo: null, status: "saved_only", detail: "Saved in the list only — not connected yet." });
  }
  return rows;
}

export function toggle(sel: string[], key: string): string[] {
  return sel.includes(key) ? sel.filter((k) => k !== key) : [...sel, key];
}
export function selectAll(sel: string[], visible: string[]): string[] {
  return [...new Set([...sel, ...visible])];
}

export type LoopEligibility = { ok: true } | { ok: false; reason: string };
/** Coding loop runs only on connected projects with a linked repo; everything else is skipped with the exact fix. */
export function loopEligible(r: ConnectRow): LoopEligibility {
  if (r.status === "saved_only") return { ok: false, reason: "Connect it first" };
  if (r.status === "connected_no_repo") return { ok: false, reason: "Link a private GitHub repo" };
  if (r.status === "repo_error") return { ok: false, reason: r.detail };
  return { ok: true };
}

export function newProjectInput(r: ConnectRow) {
  return { name: r.name, lovable_url: r.lovableRef ? lovableUrl(r.lovableRef) ?? "" : "", site_url: "", github_repo: "", github_branch: "main", description: "", goals: "", notes: "", frequency_hours: 24, active: true };
}

export type AgentState = { label: "Online" | "Working" | "Blocked" | "Offline"; reason: string };
const WORKING = new Set(["discovered", "analyzing", "patch_prepared", "testing", "delivering"]);
/** Truthful status for one project's coding loop, from real Foundry task states only. */
export function agentState(repoOk: boolean, tasks: { state: string; blocked_reason?: string | null; paused?: boolean }[]): AgentState {
  if (!repoOk) return { label: "Offline", reason: "No usable private repo" };
  const blocked = tasks.find((t) => t.state === "blocked" || t.paused);
  const working = tasks.find((t) => WORKING.has(t.state));
  if (working) return { label: "Working", reason: `Task ${working.state.replace("_", " ")}` };
  if (blocked) return { label: "Blocked", reason: blocked.blocked_reason ?? (blocked.paused ? "Paused" : "Blocked") };
  return { label: "Online", reason: tasks.some((t) => t.state === "awaiting_approval") ? "Waiting for your approval" : "Idle, ready" };
}

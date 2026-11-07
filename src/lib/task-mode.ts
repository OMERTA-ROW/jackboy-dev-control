// Task Mode pure rules: step types, risk, checkpoints, the "no approval needed" list and the runner's next move.
// Server code lives in task-mode.server.ts; UI in routes/_authenticated/tasks.tsx.

/** Step types that can NEVER skip approval, at any setting. Phase 1 has no tools for most of them; they are reserved. */
export const NEVER_SKIP = ["pay", "delete", "publish", "credentials", "send"] as const;
/** Low-risk types the owner may put on the "no approval needed" list (per project). */
export const SKIPPABLE = ["scan_site", "inspect_code", "save_draft"] as const;
export type StepType = "read" | (typeof SKIPPABLE)[number] | "open_draft_pr" | (typeof NEVER_SKIP)[number];

export const STEP_TYPE_LABEL: Record<StepType, string> = {
  read: "Read / check", scan_site: "Scan a site", inspect_code: "Inspect code", save_draft: "Save a draft",
  open_draft_pr: "Open a draft PR", pay: "Pay", delete: "Delete", publish: "Publish / deploy", credentials: "Change credentials or permissions", send: "Send to other people",
};

/** Jackboy actions a task may use. Anything else (Autopilot, background work, repo links, Foundry approvals, auto-fix) stays in chat with its own gates. */
export const TASK_TOOLS: Record<string, StepType> = {
  projectStatus: "read", connectionStatus: "read", checkStatus: "read", scanResults: "read", foundryQueue: "read",
  listRepos: "read", repoTree: "read", repoSearch: "read", readFile: "read", showDiff: "read", verifyPermissions: "read",
  capabilities: "read", checkSite: "read", listUpdates: "read", recallMemory: "read",
  scanSite: "scan_site", foundryInspect: "inspect_code",
  writeFile: "save_draft", saveMemory: "save_draft", createTask: "save_draft",
  openDraftPR: "open_draft_pr",
};

export const MAX_STEPS = 12;
export const MAX_FAILURES = 2;
export const TASK_TTL_MS = 2 * 60 * 60_000;

/** Step type is decided from the action AND its input before anything runs (writeFile with no content deletes a file). */
export function stepTypeFor(tool: string, args: Record<string, unknown>): StepType | null {
  const t = TASK_TOOLS[tool];
  if (!t) return null;
  if (tool === "writeFile" && args["content"] === null) return "delete";
  return t;
}

export type SkipRules = Partial<Record<string, string[]>>;
/** Read steps never stop; never-skip types always stop; a skippable type stops unless the owner listed this step's project for it. */
export function needsCheckpoint(type: string, projectId: string | null, rules: SkipRules): boolean {
  if (type === "read") return false;
  if ((NEVER_SKIP as readonly string[]).includes(type)) return true;
  if (!(SKIPPABLE as readonly string[]).includes(type)) return true; // unknown means checkpoint
  return !(projectId && (rules[type] ?? []).includes(projectId));
}

export function canSkip(type: string): boolean {
  return (SKIPPABLE as readonly string[]).includes(type);
}

/** Canonical JSON so the same action+input always fingerprints the same. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const stepFingerprint = (tool: string, args: Record<string, unknown>) => sha256Hex(canonical({ tool, args }));
/** Passkey target: one step, one exact action+input. */
export const stepTarget = (stepId: string, fingerprint: string) => `task_step:${stepId}:${fingerprint}`;
export const skipRuleTarget = async (type: string, projectIds: string[]) => `task_skip_rule:${type}:${await sha256Hex([...new Set(projectIds)].sort().join(","))}`;

export type TaskStatus = "draft" | "running" | "waiting" | "done" | "failed" | "stopped";
const MOVES: Record<TaskStatus, TaskStatus[]> = {
  draft: ["running", "stopped"], running: ["waiting", "done", "failed", "stopped"], waiting: ["running", "stopped"],
  failed: ["running"], stopped: ["running"], done: [],
};
export function canMove(from: TaskStatus, to: TaskStatus): boolean {
  return MOVES[from]?.includes(to) ?? false;
}

export type StepRow = { id: string; position: number; step_type: string; project_id: string | null; status: string };
export type TaskRow = { status: TaskStatus; failures: number; expires_at: string | null };
export type Next =
  | { kind: "stop"; reason: string }
  | { kind: "fail"; reason: string }
  | { kind: "done" }
  | { kind: "wait" }
  | { kind: "checkpoint"; step: StepRow }
  | { kind: "run"; step: StepRow };

/** The runner's next move. Pause or time limit stops the task at the next step; a checkpoint never runs without approval. */
export function nextMove(task: TaskRow, steps: StepRow[], ctx: { paused: boolean; rules: SkipRules; now?: number }): Next {
  if (task.status !== "running") return { kind: "wait" };
  if (ctx.paused) return { kind: "stop", reason: "Kill Switch / global pause is on." };
  if (task.expires_at && Date.parse(task.expires_at) <= (ctx.now ?? Date.now())) return { kind: "stop", reason: "Time limit reached (2 hours)." };
  if (task.failures >= MAX_FAILURES) return { kind: "fail", reason: `Stopped after ${MAX_FAILURES} failures.` };
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const step = ordered.find((s) => s.status !== "done");
  if (!step) return { kind: "done" };
  if (step.status === "running" || step.status === "waiting") return { kind: "wait" };
  if (step.status === "approved") return { kind: "run", step };
  if (step.status === "pending" || step.status === "failed" || step.status === "stopped")
    return needsCheckpoint(step.step_type, step.project_id, ctx.rules) ? { kind: "checkpoint", step } : { kind: "run", step };
  return { kind: "wait" };
}

export type DraftStep = { tool: string; args: Record<string, unknown>; why: string };
/** Check a drafted plan before it is stored. Returns plain-language problems. */
export function checkDraft(steps: DraftStep[]): string[] {
  const out: string[] = [];
  if (!steps.length) out.push("The plan has no steps.");
  if (steps.length > MAX_STEPS) out.push(`A task can have at most ${MAX_STEPS} steps.`);
  steps.forEach((s, i) => {
    const t = stepTypeFor(s.tool, s.args ?? {});
    if (!t) out.push(`Step ${i + 1}: "${s.tool}" isn't something Task Mode can do yet.`);
  });
  return out;
}

export function progress(steps: { status: string }[]): { done: number; total: number; pct: number } {
  const done = steps.filter((s) => s.status === "done").length;
  return { done, total: steps.length, pct: steps.length ? Math.round((done / steps.length) * 100) : 0 };
}

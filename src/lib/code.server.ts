// CODE uses a separate Actions-only credential, never Jackboy's repository-write credential.
import { createHash, randomBytes } from "node:crypto";
import { supabaseAdmin as db } from "@/integrations/supabase/client.server";
import { CODE_ACTION, CODE_PERMISSIONS, CODE_TTL, CODE_WORKFLOW, codeApprovalError, codeLink, codeRunName, type CodeCard, type CodeScope } from "./code";
import { codeSafetyBlockReason, getCodeSafetyState } from "./code-safety.server";
import { redactTranscript } from "./voice-guard";

type Target = { ref: string; workflowSha: string };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const codeSessionHash = (token: string) => hash(token);
async function targets(): Promise<Record<string, Target>> {
  return (await getCodeSafetyState()).allowedTargets;
}
async function gh<T>(repo: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const token = process.env["CODE_GITHUB_TOKEN"];
  if (!token) throw new Error("CODE is blocked: configure a repository-scoped GitHub Actions credential through backend secrets.");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repository.");
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`CODE GitHub request failed (${response.status}). Check the workflow, Actions scope and provider authorization.`);
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}
async function project(id: string) {
  const r = await db.from("owner_projects").select("id, github_repo, dev_enabled").eq("id", id).single();
  if (r.error || !r.data?.github_repo || !r.data.dev_enabled) throw new Error("CODE needs a linked repository with owner-enabled development for this project.");
  const p = r.data;
  const target = (await targets())[p.github_repo!];
  if (!target || !/^[\w./-]{1,100}$/.test(target.ref) || !/^[a-f0-9]{40}$/.test(target.workflowSha)) throw new Error("CODE is blocked: the owner must approve a runner ref and workflow blob SHA for this repository.");
  const safetyBlock = await codeSafetyBlockReason(p.github_repo!);
  if (safetyBlock) throw new Error(safetyBlock);
  const revision = await gh<{ sha: string }>(
    p.github_repo!,
    `/commits/${encodeURIComponent(target.ref)}`,
  );
  if (!/^[a-f0-9]{40}$/.test(revision.sha)) throw new Error("CODE target revision could not be verified.");
  return { id: p.id, repo: p.github_repo!, ...target, baseSha: revision.sha };
}
async function verify(p: { repo: string; ref: string; workflowSha: string; baseSha?: string }) {
  const [file, workflow, repo] = await Promise.all([
    gh<{ sha: string }>(p.repo, `/contents/.github/workflows/${CODE_WORKFLOW}?ref=${encodeURIComponent(p.ref)}`),
    gh<{ state: string }>(p.repo, `/actions/workflows/${CODE_WORKFLOW}`),
    gh<{ default_branch: string }>(p.repo, ""),
  ]);
  if (file.sha !== p.workflowSha || workflow.state !== "active" || p.ref !== repo.default_branch) throw new Error("CODE runner verification failed: the approved default-branch workflow changed or is disabled. Owner review required.");
  if (p.baseSha) {
    const revision = await gh<{ sha: string }>(p.repo, `/commits/${encodeURIComponent(p.ref)}`);
    if (revision.sha !== p.baseSha) throw new Error("CODE target revision changed after approval. Request a new approval.");
  }
}
/** Configuration alone never means the model runner has executed successfully. */
export async function codeCapability(): Promise<{ verified: boolean; detail: string }> {
  if (!process.env["CODE_GITHUB_TOKEN"]) return { verified: false, detail: "CODE requires a separately authorized GitHub Actions credential and an approved workflow." };
  try {
    const state = await getCodeSafetyState();
    if (!state.enabled || state.killSwitch) return { verified: false, detail: "CODE supervised execution is disabled or the emergency kill switch is engaged." };
    const blocked = Object.keys(state.allowedTargets)[0]
      ? await codeSafetyBlockReason(Object.keys(state.allowedTargets)[0]!)
      : "CODE has no owner-approved repository allowlist.";
    if (blocked) return { verified: false, detail: blocked };
  } catch {
    return { verified: false, detail: "CODE safety controls or authoritative provider spending data are unavailable." };
  }
  let approved: Record<string, Target>;
  try { approved = await targets(); } catch { return { verified: false, detail: "CODE target allowlist is unavailable or invalid; owner review is required." }; }
  for (const [repo, target] of Object.entries(approved).slice(0, 5)) {
    try {
      await verify({ repo, ...target });
      const r = await gh<{ workflow_runs: Run[] }>(repo, `/actions/workflows/${CODE_WORKFLOW}/runs?event=workflow_dispatch&per_page=100`);
      if (r.workflow_runs.some(run => /^CODE [a-f0-9-]{36}$/.test(run.display_title) && run.conclusion === "success")) return { verified: true, detail: "A live CODE workflow completed successfully. Each new job still requires its own scoped approval; tests and PRs are reported from GitHub evidence." };
    } catch { /* Remain blocked; provider setup is never inferred. */ }
  }
  return { verified: false, detail: "No successful live CODE run has been verified. Review the approved workflow and provider-native authorization, then perform the documented acceptance run." };
}
async function audit(user: string, action: string, id: string) {
  const r = await db.from("audit_logs").insert({ actor: user, action: `code.${action}`, detail: { request: id } as never, outcome: "ok" });
  if (r.error) throw new Error("CODE audit could not be recorded; no new action was dispatched.");
}
async function row(id: string, userId: string) {
  const r = await db.from("action_requests").select("*").eq("id", id).eq("action", CODE_ACTION).eq("requested_by", userId).single();
  if (r.error || !r.data) throw new Error("CODE job not found for this owner.");
  return r.data;
}
export async function codeProjectId(name: string): Promise<string> {
  const p = await db.from("owner_projects").select("id").eq("name", name).limit(2);
  if (p.error || p.data?.length !== 1) throw new Error("Use one exact, unambiguous project name for CODE.");
  return p.data[0]!.id;
}
export async function requestCode(
  projectId: string,
  instruction: string,
  userId: string,
  sessionHash: string,
  retry = false,
) {
  const p = await project(projectId);
  await verify(p); // A real read, never a configured=true claim.
  const id = crypto.randomUUID(), nonce = randomBytes(24).toString("hex");
  const scope: CodeScope = {
    repo: p.repo,
    ref: p.ref,
    workflowSha: p.workflowSha,
    baseSha: p.baseSha,
    instruction: redactTranscript(instruction),
    sessionHash,
    correlation: id,
    operation: retry ? "retry" : "dispatch",
  };
  await audit(userId, "request", id);
  const r = await db.from("action_requests").insert({ id, project_id: p.id, action: CODE_ACTION, tier: "controlled", resources: scope as never, permissions: CODE_PERMISSIONS, diff_summary: scope.instruction, risk: "controlled", nonce_hash: hash(nonce), requested_by: userId, expires_at: new Date(Date.now() + CODE_TTL).toISOString() }).select("id").single();
  if (r.error) throw new Error("Could not persist the CODE approval request.");
  return { ...(await getCode(id, userId)), nonce };
}
type Run = { id: number; display_title: string; status: string; conclusion: string | null; html_url: string };
async function findRun(scope: CodeScope): Promise<Run | undefined> {
  if (scope.runId) {
    const run = await gh<Run>(scope.repo, `/actions/runs/${scope.runId}`);
    if (run.display_title !== codeRunName(scope.correlation)) throw new Error("CODE run correlation mismatch.");
    return run;
  }
  // Requests are bounded by expiry. Pagination covers busy repositories without selecting an unrelated run.
  for (let page = 1; page <= 5; page++) {
    const r = await gh<{ workflow_runs: Run[] }>(scope.repo, `/actions/workflows/${CODE_WORKFLOW}/runs?event=workflow_dispatch&per_page=100&page=${page}`);
    const run = r.workflow_runs.find(x => x.display_title === codeRunName(scope.correlation));
    if (run) return run;
    if (r.workflow_runs.length < 100) break;
  }
  return undefined;
}
export async function getCode(id: string, userId: string): Promise<CodeCard> {
  const r = await row(id, userId), s = r.resources as unknown as CodeScope;
  const card: CodeCard = { id: r.id, projectId: r.project_id!, repo: s.repo, instruction: s.instruction, status: r.status, expiresAt: r.expires_at, permissions: r.permissions, outcome: r.outcome };
  if (r.status !== "allowed") return card;
  const run = await findRun(s);
  if (!run) return { ...card, outcome: "Awaiting GitHub run registration. If dispatch was interrupted, reconcile here before requesting another job." };
  if (!s.runId) {
    const persisted = await db.from("action_requests").update({ resources: { ...s, runId: run.id } as never }).eq("id", id).eq("action", CODE_ACTION).eq("requested_by", userId);
    if (persisted.error) throw new Error("CODE run was found but its durable run ID could not be saved. Refresh to reconcile.");
  }
  const [jobs, artifacts, prs] = await Promise.all([
    gh<{ jobs: { name: string; status: string; conclusion: string | null }[] }>(s.repo, `/actions/runs/${run.id}/jobs?per_page=100`),
    gh<{ artifacts: { id: number; name: string; expired: boolean }[] }>(s.repo, `/actions/runs/${run.id}/artifacts?per_page=100`),
    gh<{ html_url: string; draft: boolean }[]>(s.repo, `/pulls?state=all&head=${encodeURIComponent(`${s.repo.split("/")[0]}:jackboy/code-${s.correlation}`)}`),
  ]);
  const url = codeLink(run.html_url, s.repo);
  if (!url) throw new Error("GitHub returned an invalid CODE run link.");
  return { ...card, run: { id: run.id, status: run.status, conclusion: run.conclusion, url, jobs: jobs.jobs.map(j => ({ name: j.name, status: j.status, conclusion: j.conclusion })), downloads: artifacts.artifacts.filter(a => !a.expired).flatMap(a => { const u = codeLink(`${url}/artifacts/${a.id}`, s.repo); return u ? [{ name: a.name, url: u }] : []; }), pr: codeLink(prs.find(p => p.draft)?.html_url, s.repo) } };
}
export async function decideCode(id: string, nonce: string, decision: "allow" | "deny", userId: string, sessionHash: string) {
  const r = await row(id, userId), scope = r.resources as unknown as CodeScope;
  const bad = codeApprovalError({ ...r, resources: scope }, userId, sessionHash);
  if (bad) throw new Error(bad);
  if (r.nonce_hash !== hash(nonce)) throw new Error("CODE approval nonce is invalid.");
  if (decision === "allow") {
    const p = await project(r.project_id!);
    if (
      p.repo !== scope.repo ||
      p.ref !== scope.ref ||
      p.workflowSha !== scope.workflowSha ||
      p.baseSha !== scope.baseSha
    ) {
      throw new Error("CODE target changed. Request a new approval.");
    }
    await verify(p);
  }
  // Only the winner of this compare-and-swap may dispatch. A timeout never automatically retries a dispatch.
  const won = await db.from("action_requests").update({ status: decision === "allow" ? "allowed" : "denied", decided_by: userId, decided_at: new Date().toISOString(), mode: "once", outcome: decision === "allow" ? "Dispatch pending" : "Denied" }).eq("id", id).eq("status", "pending").eq("requested_by", userId).eq("nonce_hash", hash(nonce)).gt("expires_at", new Date().toISOString()).select("id").maybeSingle();
  if (won.error || !won.data) throw new Error("CODE approval is stale, expired, or already used.");
  await audit(userId, decision, id);
  if (decision === "allow") {
    try {
      await gh(
        scope.repo,
        `/actions/workflows/${CODE_WORKFLOW}/dispatches`,
        "POST",
        { ref: scope.ref, inputs: { request_id: id } },
      );
      await db.from("action_requests").update({ outcome: "Accepted by GitHub; waiting for runner evidence" }).eq("id", id);
    } catch {
      await db.from("action_requests").update({ outcome: "Dispatch outcome uncertain. Refresh to reconcile with GitHub; no automatic redispatch occurred." }).eq("id", id);
    }
  }
  return getCode(id, userId);
}
export async function controlCode(id: string, op: "cancel" | "retry", userId: string, sessionHash: string) {
  const r = await row(id, userId), scope = r.resources as unknown as CodeScope;
  const run = await findRun(scope);
  if (r.status !== "allowed" || !run) throw new Error("No authorized CODE run exists yet.");
  if (op === "retry") {
    if (run.status !== "completed" || !["failure", "timed_out", "cancelled"].includes(run.conclusion ?? "")) throw new Error("This CODE run cannot be retried.");
    return requestCode(r.project_id!, scope.instruction, userId, sessionHash, true);
  }
  await audit(userId, "cancel", id);
  if (run.status !== "completed") await gh(scope.repo, `/actions/runs/${run.id}/cancel`, "POST");
  return getCode(id, userId);
}

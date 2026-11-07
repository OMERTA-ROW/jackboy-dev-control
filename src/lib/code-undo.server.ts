// CODE Undo runtime. Rules live in code-undo.ts. Writes use the repository-write credential through
// github.server.ts (never the Actions-only CODE token). Every step is recorded in code_undos and the Site Log.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { CODE_ACTION, type CodeScope } from "./code";
import { getCodeSafetyState } from "./code-safety.server";
import { revertClashes, revertNextStep, revertPlan, undoBlockReason, undoKind, undoNeedsPasskey, undoTarget, UNDO_STEP_UP, type UndoKind } from "./code-undo";
import * as gh from "./github.server";
import { logSite } from "./site-log.server";
import { untyped } from "./untyped-db";

const db = () => untyped(supabaseAdmin);
const split = (repo: string) => { const [owner, name] = repo.split("/"); if (!owner || !name) throw new Error("Invalid repository."); return { owner, name }; };
const codeBranch = (correlation: string) => `jackboy/code-${correlation}`;

export type UndoState = {
  requestId: string;
  repo: string;
  prNumber: number | null;
  prUrl: string | null;
  kind: UndoKind | null;
  needsPasskey: boolean;
  blocked: string | null;
  undo: { status: string; detail: string | null; revertPrUrl: string | null; republishNeeded: boolean; finishedAt: string | null } | null;
};

async function request(requestId: string) {
  const r = await supabaseAdmin.from("action_requests").select("id, project_id, status, resources").eq("id", requestId).eq("action", CODE_ACTION).maybeSingle();
  if (r.error || !r.data) throw new Error("CODE change not found.");
  const scope = r.data.resources as unknown as CodeScope;
  if (!scope?.repo || !scope.correlation) throw new Error("This CODE request has no repository change.");
  return { row: r.data, scope };
}
async function existingUndo(requestId: string) {
  const { data } = await db().from("code_undos").select("*").eq("request_id", requestId).maybeSingle();
  return data as null | { id: string; status: string; detail: string | null; revert_pr_url: string | null; revert_pr_number: number | null; revert_head_sha: string | null; republish_needed: boolean; finished_at: string | null; created_at: string; repo: string };
}
async function context(requestId: string) {
  const { scope } = await request(requestId);
  const { owner, name } = split(scope.repo);
  const pr = await gh.findPullByHead(owner, name, codeBranch(scope.correlation));
  let killSwitch: boolean | null = null, repoAllowed = false;
  try { const s = await getCodeSafetyState(); killSwitch = s.killSwitch; repoAllowed = Boolean(s.allowedTargets[scope.repo]); } catch { /* fail closed */ }
  const existing = await existingUndo(requestId);
  const kind = pr ? undoKind(pr) : null;
  return { scope, owner, name, pr, existing, kind, blocked: pr ? undoBlockReason({ kind, killSwitch, repoAllowed, existing }) : "This CODE request has no pull request yet." };
}

export async function getUndoState(requestId: string): Promise<UndoState> {
  const c = await context(requestId);
  return {
    requestId,
    repo: c.scope.repo,
    prNumber: c.pr?.number ?? null,
    prUrl: c.pr?.html_url ?? null,
    kind: c.kind,
    needsPasskey: c.kind ? undoNeedsPasskey(c.kind) : false,
    blocked: c.blocked,
    undo: c.existing ? { status: c.existing.status, detail: c.existing.detail, revertPrUrl: c.existing.revert_pr_url, republishNeeded: c.existing.republish_needed, finishedAt: c.existing.finished_at } : null,
  };
}

/** Recent CODE changes that have a PR, newest first (for the Undo list). */
export async function listUndoable(limit = 10): Promise<UndoState[]> {
  const { data } = await supabaseAdmin.from("action_requests").select("id").eq("action", CODE_ACTION).eq("status", "allowed").order("created_at", { ascending: false }).limit(limit);
  const out: UndoState[] = [];
  for (const r of data ?? []) {
    try { const s = await getUndoState(r.id); if (s.prNumber) out.push(s); } catch { /* skip unreadable */ }
  }
  return out;
}

async function record(fields: Record<string, unknown>, id?: string) {
  if (id) {
    const { error } = await db().from("code_undos").update(fields).eq("id", id);
    if (error) throw new Error("The undo record could not be saved.");
    return id;
  }
  const { data, error } = await db().from("code_undos").insert(fields).select("id").single();
  if (error || !data) throw new Error(/duplicate|unique/i.test(error?.message ?? "") ? "Undo is already in progress for this change." : "The undo record could not be saved.");
  return (data as { id: string }).id;
}

export async function undoCode(requestId: string, userId: string, grantId?: string): Promise<UndoState> {
  const c = await context(requestId);
  if (c.blocked || !c.pr || !c.kind) throw new Error(c.blocked ?? "Nothing to undo.");
  const pr = c.pr, project = (await request(requestId)).row.project_id;
  if (c.kind === "revert_merged") {
    await (await import("./passkey.server")).consumeGrant(grantId, userId, UNDO_STEP_UP, undoTarget(requestId), { requireFresh: true });
  }
  // A failed earlier attempt is retried on the same record; the unique request_id stops double presses.
  const id = c.existing?.status === "failed"
    ? await record({ status: "started", detail: null, actor: userId, kind: c.kind, finished_at: null }, c.existing.id)
    : await record({ request_id: requestId, repo: c.scope.repo, pr_number: pr.number, kind: c.kind, status: "started", actor: userId });
  await supabaseAdmin.from("audit_logs").insert({ actor: userId, action: "code.undo_started", detail: { request: requestId, pr: pr.number, kind: c.kind } as never, outcome: "ok" });
  try {
    await gh.requirePrivateRepo(c.owner, c.name);
    if (c.kind === "close_draft") {
      await gh.closePullRequest(c.owner, c.name, pr.number);
      await record({ status: "done", detail: `Closed PR #${pr.number}. The branch is kept, so it can be reopened.`, finished_at: new Date().toISOString() }, id);
      await logSite({ actor: userId, action: "code.undo", category: "rollback", status: "rolled_back", summary: `Undo: closed draft PR #${pr.number} without merging.`, repo: c.scope.repo, branch: pr.head.ref, pr_url: pr.html_url, project_id: project ?? null });
      return getUndoState(requestId);
    }
    // Revert a merged change: restore every touched file to its exact pre-merge version.
    if (!pr.merge_commit_sha) throw new Error("GitHub didn't report the merge commit, so the change can't be undone safely.");
    const files = await gh.listPullFiles(c.owner, c.name, pr.number);
    const plan = revertPlan(files);
    if (plan.error) throw new Error(plan.error);
    const base = pr.base.ref;
    const parents = await gh.getCommitParents(c.owner, c.name, pr.merge_commit_sha);
    const before = parents[0];
    if (!before) throw new Error("The merge has no parent commit; undo refused.");
    const clashes = revertClashes(await Promise.all(plan.touched.map(async (path) => ({
      path,
      afterMerge: await gh.fileBlobSha(c.owner, c.name, path, pr.merge_commit_sha!),
      onMainNow: await gh.fileBlobSha(c.owner, c.name, path, base),
    }))));
    if (clashes.length) {
      await record({ status: "refused", detail: `Newer work changed: ${clashes.slice(0, 10).join(", ")}. Nothing was overwritten; revert it in GitHub with a review instead.`, finished_at: new Date().toISOString() }, id);
      return getUndoState(requestId);
    }
    const changes: { path: string; content: string | null }[] = plan.remove.map((path) => ({ path, content: null }));
    for (const path of plan.restore) {
      const content = await gh.readFile(c.owner, c.name, path, before);
      if (content === null) throw new Error(`${path} is too large or not text, so one-press Undo can't restore it. Revert it in GitHub instead.`);
      changes.push({ path, content });
    }
    const branch = `jackboy/undo-${requestId.slice(0, 8)}-${Date.now().toString(36)}`;
    const sha = await gh.commitToNewBranch(c.owner, c.name, base, branch, `Undo Jackboy CODE change (PR #${pr.number})`, changes);
    const revert = await gh.openPullRequest(c.owner, c.name, branch, base, `Undo: revert Jackboy PR #${pr.number}`, `Owner pressed Undo and confirmed with a passkey. Restores ${plan.touched.length} file(s) to their state before PR #${pr.number}. Jackboy merges this only after its checks pass.`, false);
    await record({ status: "waiting_checks", revert_pr_number: revert.number, revert_pr_url: revert.html_url, revert_head_sha: sha, republish_needed: true, detail: "Waiting for checks on the revert before merging." }, id);
    await logSite({ actor: userId, action: "code.undo", category: "rollback", status: "pending", summary: `Undo: opened revert PR #${revert.number} for PR #${pr.number}; merges after checks pass.`, repo: c.scope.repo, branch, commit_sha: sha, pr_url: revert.html_url, project_id: project ?? null });
    return getUndoState(requestId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await record({ status: "failed", detail: msg.slice(0, 500), finished_at: new Date().toISOString() }, id).catch(() => {});
    await logSite({ actor: userId, action: "code.undo", category: "error", status: "failed", summary: `Undo failed for PR #${pr.number}: ${msg}`.slice(0, 1900), repo: c.scope.repo, pr_url: pr.html_url }).catch(() => {});
    throw new Error(msg);
  }
}

/** Advances reverts waiting on checks: merge on success, stop on failure. Bounded; safe to call often. */
export async function advanceUndos(limit = 5) {
  const { data } = await db().from("code_undos").select("*").eq("status", "waiting_checks").order("created_at").limit(limit);
  const results: { id: string; step: string }[] = [];
  for (const u of (data ?? []) as { id: string; repo: string; revert_pr_number: number; revert_head_sha: string; created_at: string; actor: string; pr_number: number; revert_pr_url: string }[]) {
    try {
      const { owner, name } = split(u.repo);
      const step = revertNextStep(await gh.checksState(owner, name, u.revert_head_sha), Date.parse(u.created_at));
      results.push({ id: u.id, step });
      if (step === "wait") continue;
      if (step === "merge") {
        const pr = await gh.getPullRequest(owner, name, u.revert_pr_number);
        if (pr.head.sha !== u.revert_head_sha) throw new Error("The revert branch changed after it was opened; Jackboy won't merge it.");
        const m = await gh.mergePullRequest(owner, name, u.revert_pr_number, u.revert_head_sha);
        await record({ status: "done", merged_sha: m.sha, detail: "Checks passed and the revert was merged. If the change was live, republish the site.", finished_at: new Date().toISOString() }, u.id);
        await logSite({ actor: u.actor, action: "code.undo_merged", category: "rollback", status: "rolled_back", summary: `Undo complete: revert PR #${u.revert_pr_number} merged after checks passed (undid PR #${u.pr_number}).`, repo: u.repo, commit_sha: m.sha, pr_url: u.revert_pr_url });
      } else {
        const detail = step === "fail_checks" ? "Checks failed on the revert, so it wasn't merged. Review it in GitHub." : "No checks ran on the revert within 30 minutes, so it wasn't merged. Review and merge it in GitHub.";
        await record({ status: "failed", detail, finished_at: new Date().toISOString() }, u.id);
        await logSite({ actor: u.actor, action: "code.undo", category: "error", status: "failed", summary: `Undo stopped: ${detail}`, repo: u.repo, pr_url: u.revert_pr_url });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await record({ status: "failed", detail: `Merging the revert failed: ${msg}`.slice(0, 500), finished_at: new Date().toISOString() }, u.id).catch(() => {});
      results.push({ id: u.id, step: "error" });
    }
  }
  return results;
}

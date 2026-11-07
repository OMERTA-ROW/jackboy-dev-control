// Server-only GitHub issue/PR preparation. Reads CI checks and reviews live from GitHub; the only
// writes are creating an issue and opening a DRAFT PR from a jackboy/* branch. No merge/deploy.
import * as gh from "./github.server";
import {
  buildIssueBody,
  buildPrBody,
  prStatusLine,
  summarizeCi,
  summarizeReviews,
  validatePrBranch,
  validatePrepText,
  type CiSummary,
} from "./github-prep";
import { logSiteStrict } from "./site-log.server";
import { assertWorkAllowed } from "./global-pause.server";

export type RepoRef = { owner: string; repo: string; base: string; projectId: string; projectName: string };

export async function ciEvidence(t: RepoRef, ref: string): Promise<CiSummary> {
  const sha = await gh.commitShaForRef(t.owner, t.repo, ref);
  const [runs, statuses] = await Promise.all([
    gh.listCheckRuns(t.owner, t.repo, sha),
    gh.listCommitStatuses(t.owner, t.repo, sha),
  ]);
  return summarizeCi(sha, runs, statuses);
}

/** Read-only: open PRs with CI evidence and review status. */
export async function pullSummaries(t: RepoRef) {
  const pulls = await gh.listOpenPulls(t.owner, t.repo, 10);
  return Promise.all(
    pulls.map(async (p) => {
      const [runs, statuses, reviews] = await Promise.all([
        gh.listCheckRuns(t.owner, t.repo, p.head.sha),
        gh.listCommitStatuses(t.owner, t.repo, p.head.sha),
        gh.listPullReviews(t.owner, t.repo, p.number),
      ]);
      const ci = summarizeCi(p.head.sha, runs, statuses);
      const review = summarizeReviews(
        reviews,
        p.requested_reviewers.map((u) => u.login),
        p.requested_teams.map((x) => x.slug),
      );
      return {
        number: p.number,
        title: p.title,
        url: p.html_url,
        draft: p.draft,
        author: p.user?.login ?? null,
        branch: p.head.ref,
        updatedAt: p.updated_at,
        ci,
        review,
        line: prStatusLine(ci, review, p.draft),
      };
    }),
  );
}

export async function previewIssue(t: RepoRef, title: string, problem: string, ref?: string) {
  const bad = validatePrepText({ title, text: problem });
  if (bad) throw new Error(bad);
  const at = ref || t.base;
  let ci: CiSummary | null = null;
  try {
    ci = await ciEvidence(t, at);
  } catch {
    ci = null; // Shown honestly as "not available"; never invented.
  }
  return { title: title.trim(), body: buildIssueBody({ problem, ci, ref: at, projectName: t.projectName }), ci, ref: at };
}

export async function createPreparedIssue(actor: string, t: RepoRef, title: string, problem: string, ref?: string) {
  await assertWorkAllowed();
  const draft = await previewIssue(t, title, problem, ref);
  await gh.requirePrivateRepo(t.owner, t.repo);
  const repo = `${t.owner}/${t.repo}`;
  await logSiteStrict({
    actor, action: "github.issue.request", category: "activity", status: "pending",
    summary: `Owner asked Jackboy to open an issue: ${draft.title}`, project_id: t.projectId, repo,
  });
  const issue = await gh.createIssue(t.owner, t.repo, draft.title, draft.body);
  await logSiteStrict({
    actor, action: "github.issue.created", category: "activity", status: "ok",
    summary: `Issue #${issue.number} opened with CI evidence (${draft.ci?.state ?? "none"})`,
    project_id: t.projectId, repo, issue: issue.html_url, source_url: issue.html_url,
  });
  return { number: issue.number, url: issue.html_url, ci: draft.ci };
}

export async function previewDraftPr(t: RepoRef, branch: string, title: string, summary: string, issueNumber?: number | null) {
  const bad = validatePrepText({ title, text: summary }) ?? validatePrBranch(branch, t.base);
  if (bad) throw new Error(bad);
  if (!(await gh.branchExists(t.owner, t.repo, branch))) throw new Error(`Branch ${branch} doesn't exist in ${t.owner}/${t.repo}.`);
  const existing = await gh.findPullByHead(t.owner, t.repo, branch);
  if (existing && existing.state === "open") throw new Error(`Pull request #${existing.number} already exists for ${branch}.`);
  let ci: CiSummary | null = null;
  try {
    ci = await ciEvidence(t, branch);
  } catch {
    ci = null;
  }
  return { title: title.trim(), body: buildPrBody({ summary, ci, branch, issueNumber: issueNumber ?? null }), ci, branch, base: t.base };
}

/** Always a draft. Never merges, marks ready or requests deployment. */
export async function openPreparedDraftPr(
  actor: string, t: RepoRef, branch: string, title: string, summary: string, issueNumber?: number | null,
) {
  await assertWorkAllowed();
  const draft = await previewDraftPr(t, branch, title, summary, issueNumber);
  await gh.requirePrivateRepo(t.owner, t.repo);
  const repo = `${t.owner}/${t.repo}`;
  await logSiteStrict({
    actor, action: "github.pr.request", category: "activity", status: "pending",
    summary: `Owner asked Jackboy to open a draft pull request from ${branch}`, project_id: t.projectId, repo, branch,
  });
  const pr = await gh.openPullRequest(t.owner, t.repo, branch, t.base, draft.title, draft.body, true);
  await logSiteStrict({
    actor, action: "github.pr.draft_opened", category: "activity", status: "ok",
    summary: `Draft pull request #${pr.number} opened with CI evidence (${draft.ci?.state ?? "none"}); merging stays with the owner`,
    project_id: t.projectId, repo, branch, pr_url: pr.html_url,
  });
  return { number: pr.number, url: pr.html_url, ci: draft.ci };
}

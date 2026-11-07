// Pure rules for GitHub issue and pull request preparation. Jackboy may only open issues and
// DRAFT pull requests from its own `jackboy/*` branches, with CI evidence and review status
// taken from GitHub. It never merges, marks ready, approves, deploys or changes settings.
import { checkWorkBranch } from "./repo-workspace";

/** The only GitHub writes this feature can perform. Merge/deploy are deliberately absent. */
export const PREP_WRITES = ["create_issue", "open_draft_pr"] as const;
export type PrepWrite = (typeof PREP_WRITES)[number];
export function isPrepWriteAllowed(action: string): action is PrepWrite {
  return (PREP_WRITES as readonly string[]).includes(action);
}

export type CheckRun = { name: string; status: string; conclusion: string | null; html_url?: string | null };
export type CommitStatus = { context: string; state: string; target_url?: string | null };
export type CiItem = { name: string; result: "passed" | "failed" | "running" | "skipped"; url: string | null };
export type CiSummary = {
  state: "passed" | "failed" | "running" | "none";
  sha: string;
  passed: number;
  failed: number;
  running: number;
  items: CiItem[];
};

const FAILED = ["failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"];

export function summarizeCi(sha: string, runs: CheckRun[], statuses: CommitStatus[]): CiSummary {
  // GitHub returns every status ever posted; only the newest per context counts.
  const latest = new Map<string, CommitStatus>();
  for (const s of statuses) if (!latest.has(s.context)) latest.set(s.context, s);
  const items: CiItem[] = [
    ...runs.map((r): CiItem => ({
      name: r.name,
      url: r.html_url ?? null,
      result:
        r.status !== "completed"
          ? "running"
          : r.conclusion === "success"
            ? "passed"
            : r.conclusion === "skipped" || r.conclusion === "neutral"
              ? "skipped"
              : FAILED.includes(r.conclusion ?? "") ? "failed" : "running",
    })),
    ...[...latest.values()].map((s): CiItem => ({
      name: s.context,
      url: s.target_url ?? null,
      result: s.state === "success" ? "passed" : s.state === "pending" ? "running" : "failed",
    })),
  ];
  const count = (r: CiItem["result"]) => items.filter((i) => i.result === r).length;
  const failed = count("failed"), running = count("running"), passed = count("passed");
  const state = items.length === 0 ? "none" : failed ? "failed" : running ? "running" : "passed";
  return { state, sha, passed, failed, running, items };
}

export type Review = { user: { login: string } | null; state: string; submitted_at?: string | null };
export type ReviewSummary = {
  state: "approved" | "changes_requested" | "waiting" | "no_review";
  approvals: string[];
  changesRequested: string[];
  waitingOn: string[];
};

/** Latest decisive review per person wins; comments never count as approval. */
export function summarizeReviews(reviews: Review[], requestedUsers: string[], requestedTeams: string[]): ReviewSummary {
  const last = new Map<string, string>();
  for (const r of reviews) {
    const who = r.user?.login;
    if (!who) continue;
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED" || r.state === "DISMISSED") last.set(who, r.state);
  }
  const approvals = [...last].filter(([, s]) => s === "APPROVED").map(([w]) => w);
  const changesRequested = [...last].filter(([, s]) => s === "CHANGES_REQUESTED").map(([w]) => w);
  const waitingOn = [...requestedUsers, ...requestedTeams.map((t) => `team ${t}`)];
  const state = changesRequested.length
    ? "changes_requested"
    : waitingOn.length
      ? "waiting"
      : approvals.length
        ? "approved"
        : "no_review";
  return { state, approvals, changesRequested, waitingOn };
}

const CI_LABEL: Record<CiSummary["state"], string> = {
  passed: "All checks passed",
  failed: "Some checks failed",
  running: "Checks still running",
  none: "No CI checks reported",
};
const REVIEW_LABEL: Record<ReviewSummary["state"], string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  waiting: "Waiting for review",
  no_review: "No review yet",
};
export const ciLabel = (s: CiSummary["state"]) => CI_LABEL[s];
export const reviewLabel = (s: ReviewSummary["state"]) => REVIEW_LABEL[s];

/** One plain line for a PR: CI + review, and always that merging stays with the owner. */
export function prStatusLine(ci: CiSummary, review: ReviewSummary, draft: boolean): string {
  const parts = [draft ? "Draft" : "Open", CI_LABEL[ci.state], REVIEW_LABEL[review.state]];
  if (review.changesRequested.length) parts.push(`changes asked by ${review.changesRequested.join(", ")}`);
  if (review.waitingOn.length) parts.push(`waiting on ${review.waitingOn.join(", ")}`);
  return `${parts.join(" · ")}. Merging stays with you in GitHub.`;
}

function ciMarkdown(ci: CiSummary, ref: string): string {
  const head = `**CI evidence** for \`${ref}\` at \`${ci.sha.slice(0, 12)}\`: ${CI_LABEL[ci.state]} (${ci.passed} passed, ${ci.failed} failed, ${ci.running} running).`;
  if (!ci.items.length) return head;
  const rows = ci.items
    .slice(0, 30)
    .map((i) => `- ${i.result === "passed" ? "✅" : i.result === "failed" ? "❌" : i.result === "skipped" ? "⏭️" : "⏳"} ${i.url ? `[${i.name}](${i.url})` : i.name}`);
  return [head, "", ...rows].join("\n");
}

const FOOTER =
  "_Prepared by Jackboy from live GitHub data. Jackboy cannot merge, approve, mark ready or deploy — those stay with the owner._";

export function buildIssueBody(i: { problem: string; ci: CiSummary | null; ref: string; projectName: string }): string {
  return [
    `**Project:** ${i.projectName}`,
    "",
    "### What's wrong",
    i.problem.trim(),
    "",
    i.ci ? ciMarkdown(i.ci, i.ref) : "**CI evidence:** not available for this ref.",
    "",
    FOOTER,
  ].join("\n");
}

export function buildPrBody(p: { summary: string; ci: CiSummary | null; branch: string; issueNumber?: number | null }): string {
  return [
    "### Summary",
    p.summary.trim(),
    ...(p.issueNumber ? ["", `Refs #${p.issueNumber}`] : []),
    "",
    p.ci ? ciMarkdown(p.ci, p.branch) : "**CI evidence:** no checks have reported on this branch yet.",
    "",
    "This pull request is a **draft**. Review it and merge it yourself in GitHub if you agree.",
    "",
    FOOTER,
  ].join("\n");
}

export type PrepInput = { title: string; text: string };
export function validatePrepText(i: PrepInput): string | null {
  if (i.title.trim().length < 5 || i.title.length > 200) return "Title must be 5–200 characters.";
  if (i.text.trim().length < 10 || i.text.length > 8000) return "Description must be 10–8000 characters.";
  return null;
}

/** Draft PRs only from Jackboy work branches into the project's base branch. */
export function validatePrBranch(branch: string, base: string): string | null {
  return checkWorkBranch(branch, base);
}

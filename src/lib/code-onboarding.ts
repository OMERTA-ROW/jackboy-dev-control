// Pure rules for "Add project to CODE": workflow version choice, the owner checklist and its gates.
// Nothing here talks to GitHub or the database; the server module supplies live reads.
import type { CodeTarget } from "./code-safety";

export const ONBOARD_BRANCH = "jackboy/code-onboarding";
export const ANCHOR_REPO = "OMERTA-ROW/jackboy-dev-control";
export const MAX_CODE_SITES = 10;
export const CODE_RUNNER_ORIGIN = "https://jackboy-dev-control.lovable.app";

export type ProfileKind = "web" | "go";
export const PROFILE_LABEL: Record<ProfileKind, string> = { web: "Lovable web app (bun/npm)", go: "Go" };
/** Files each onboarding PR adds. The workflow blob SHA is the pin; the scripts must match too. */
export const PROFILE_PATHS = {
  workflow: ".github/workflows/code.yml",
  evidence: "scripts/code-evidence.mjs",
  patch: "scripts/code-patch.mjs",
  validation: "scripts/code-validation.sh",
} as const;
export type ProfilePath = (typeof PROFILE_PATHS)[keyof typeof PROFILE_PATHS];
export type ProfileFile = { path: ProfilePath; content: string; sha: string };

/** Git blob SHA-1 of exact file bytes: what GitHub reports for a file, identical before and after a merge. */
export async function gitBlobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content);
  const head = new TextEncoder().encode(`blob ${body.length}\0`);
  const all = new Uint8Array(head.length + body.length);
  all.set(head); all.set(body, head.length);
  const d = await crypto.subtle.digest("SHA-1", all);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Which approved workflow version fits a repo, from its root files. null + reason when none fits. */
export function detectProfile(rootFiles: string[], pkgScripts: Record<string, string> | null): { kind: ProfileKind } | { kind: null; reason: string } {
  const has = (f: string) => rootFiles.includes(f);
  if (has("go.mod")) return { kind: "go" };
  if (has("package.json")) {
    if (!has("bun.lock") && !has("bun.lockb") && !has("package-lock.json"))
      return { kind: null, reason: "No lockfile (bun.lock, bun.lockb or package-lock.json), so dependencies can't be installed reproducibly. Commit a lockfile first." };
    if (!pkgScripts?.["build"]) return { kind: null, reason: "package.json has no build script, so CODE could never validate a change. Add a build script first." };
    return { kind: "web" };
  }
  return { kind: null, reason: "Neither package.json nor go.mod at the repository root; no approved CODE workflow version fits this project yet." };
}

/** The exact CODE_TARGETS value to save: keeps every current entry and adds or replaces this site's. */
export function nextCodeTargetsValue(current: Record<string, CodeTarget>, repo: string, workflowSha: string): string {
  const next: Record<string, CodeTarget> = {};
  for (const [r, t] of Object.entries(current)) next[r] = { ref: t.ref, workflowSha: t.workflowSha };
  next[repo] = { ref: "main", workflowSha };
  return JSON.stringify(next);
}

/** CODE_TARGETS value after removing a site (never removes the Jackboy anchor site). */
export function codeTargetsWithout(current: Record<string, CodeTarget>, repo: string): string {
  const next: Record<string, CodeTarget> = {};
  for (const [r, t] of Object.entries(current)) if (r !== repo) next[r] = { ref: t.ref, workflowSha: t.workflowSha };
  return JSON.stringify(next);
}

/** Passkey targets: each grant is bound to one site and, when adding, to one exact workflow SHA. */
export const siteAddTarget = (repo: string, sha: string) => `code_site:add:${repo}:${sha}`;
export const siteRemoveTarget = (repo: string) => `code_site:remove:${repo}`;

export type CheckStatus = "done" | "waiting" | "blocked";
export type CheckItem = { id: string; label: string; status: CheckStatus; detail: string; fix?: string; gate: boolean };

/** Live facts gathered (read-only) for one site. null = could not be read. */
export type SiteFacts = {
  repo: string;
  defaultBranch: string | null;
  appCanWrite: boolean;
  profile: { kind: ProfileKind } | { kind: null; reason: string };
  expected: ProfileFile[];
  branchFiles: Partial<Record<ProfilePath, string | null>>; // blob SHAs on the onboarding branch
  mainFiles: Partial<Record<ProfilePath, string | null>>; // blob SHAs on main
  pr: { number: number; url: string; state: "open" | "merged" | "closed" } | null;
  workflowWriteRefused: boolean;
  environments: { CODE: EnvState; "CODE-PUBLISH": EnvState } | null; // null: no credential could read them
  dispatchCredential: "ok" | "no_access" | "missing" | "workflow_missing";
  runnerVariable: "ok" | "wrong" | "missing" | "unreadable";
  codeTargets: { present: boolean; parses: boolean; entry: CodeTarget | null };
  pinned: CodeTarget | null;
  pinStorageReady: boolean; // reviewed database update applied
  siteCount: number;
  activeTask: boolean;
};
export type EnvState = { exists: boolean; protected: boolean; readable: boolean };

const sameAll = (want: ProfileFile[], got: Partial<Record<ProfilePath, string | null>>) => want.length > 0 && want.every((f) => got[f.path] === f.sha);

/** Owner checklist in order. `gate` items must all be done before the passkey activation is offered. */
export function buildChecklist(f: SiteFacts): CheckItem[] {
  const wf = f.expected.find((x) => x.path === PROFILE_PATHS.workflow);
  const sha = wf?.sha ?? "";
  const items: CheckItem[] = [];
  items.push(f.profile.kind
    ? { id: "profile", label: "Workflow version chosen", status: "done", detail: `${PROFILE_LABEL[f.profile.kind]} · workflow ${sha.slice(0, 12)}…`, gate: true }
    : { id: "profile", label: "Workflow version chosen", status: "blocked", detail: f.profile.reason, gate: true });
  items.push(f.defaultBranch === "main"
    ? { id: "branch", label: "Default branch is main", status: "done", detail: "CODE runs only on main.", gate: true }
    : { id: "branch", label: "Default branch is main", status: "blocked", detail: f.defaultBranch ? `Default branch is ${f.defaultBranch}.` : "Repository could not be read.", fix: "CODE pins only main. Rename the default branch to main in GitHub first.", gate: true });
  items.push(f.appCanWrite
    ? { id: "app", label: "Jackboy GitHub App can open the PR", status: "done", detail: "Installed with Contents write.", gate: false }
    : { id: "app", label: "Jackboy GitHub App can open the PR", status: "blocked", detail: "The App is not installed on this repo or lacks Contents write.", fix: "Add this repository to the OMERTA-ROW GitHub App installation.", gate: false });

  const merged = sameAll(f.expected, f.mainFiles);
  const onBranch = sameAll(f.expected, f.branchFiles);
  if (merged) items.push({ id: "pr", label: "Onboarding PR merged", status: "done", detail: "The approved workflow and scripts are on main.", gate: true });
  else if (f.pr?.state === "open") items.push({ id: "pr", label: "Onboarding PR merged", status: "waiting", detail: `Draft PR #${f.pr.number} is open${onBranch ? "" : " but its files don't match the approved version yet"}.`, fix: "Review it, mark it ready and merge it in GitHub. Jackboy never merges.", gate: true });
  else if (f.workflowWriteRefused && !f.branchFiles[PROFILE_PATHS.workflow]) items.push({ id: "pr", label: "Onboarding PR merged", status: "waiting", detail: "GitHub refused to let the App add the workflow file (it lacks the Workflows permission).", fix: "Add the workflow file yourself (copy below) to the jackboy/code-onboarding branch, or give the App Workflows: Read & write, then Prepare again.", gate: true });
  else if (f.pr?.state === "merged") items.push({ id: "pr", label: "Onboarding PR merged", status: "blocked", detail: "The PR was merged, but the files on main don't match the approved version.", fix: "Press Prepare again to open a correcting PR.", gate: true });
  else items.push({ id: "pr", label: "Onboarding PR merged", status: "waiting", detail: "No onboarding PR yet.", fix: "Press Prepare to open the draft PR.", gate: true });

  const env = (name: "CODE" | "CODE-PUBLISH"): CheckItem => {
    const e = f.environments?.[name];
    if (!e || !e.readable) return { id: `env-${name}`, label: `GitHub environment ${name} needs your approval`, status: "blocked", detail: "Jackboy couldn't read this environment's protection rules.", fix: "Give CODE_GITHUB_TOKEN read access to this repo, then Re-check.", gate: true };
    if (!e.exists) return { id: `env-${name}`, label: `GitHub environment ${name} needs your approval`, status: "waiting", detail: "The environment doesn't exist yet. If left missing, GitHub creates it on the first run without reviewers.", fix: `Repo → Settings → Environments → New environment "${name}": add yourself as required reviewer, turn on "Prevent self-review" and turn off admin bypass.`, gate: true };
    return e.protected
      ? { id: `env-${name}`, label: `GitHub environment ${name} needs your approval`, status: "done", detail: "Required reviewer set, self-review prevented, no admin bypass.", gate: true }
      : { id: `env-${name}`, label: `GitHub environment ${name} needs your approval`, status: "blocked", detail: "The environment exists but doesn't require your approval on every run.", fix: "Add a required reviewer, turn on Prevent self-review and turn off admin bypass.", gate: true };
  };
  items.push(env("CODE"), env("CODE-PUBLISH"));

  items.push(f.runnerVariable === "ok"
    ? { id: "variable", label: "Runner address set", status: "done", detail: `CODE_RUNNER_AUTH_URL = ${CODE_RUNNER_ORIGIN}`, gate: false }
    : { id: "variable", label: "Runner address set", status: f.runnerVariable === "unreadable" ? "waiting" : "blocked", detail: f.runnerVariable === "unreadable" ? "Jackboy can't read repo variables with its current access; runs fail safely if it's missing." : f.runnerVariable === "wrong" ? "CODE_RUNNER_AUTH_URL has a different value." : "CODE_RUNNER_AUTH_URL is not set.", fix: `Repo → Settings → Secrets and variables → Actions → Variables: CODE_RUNNER_AUTH_URL = ${CODE_RUNNER_ORIGIN}`, gate: false });

  const dc: Record<SiteFacts["dispatchCredential"], CheckItem> = {
    ok: { id: "dispatch", label: "Run-starting credential reaches this repo", status: "done", detail: "CODE_GITHUB_TOKEN can see the active CODE workflow. Start permission is only proven by your first approved run.", gate: true },
    workflow_missing: { id: "dispatch", label: "Run-starting credential reaches this repo", status: "waiting", detail: "CODE_GITHUB_TOKEN reaches the repo, but the CODE workflow isn't on main yet.", fix: "Merge the onboarding PR first.", gate: true },
    no_access: { id: "dispatch", label: "Run-starting credential reaches this repo", status: "blocked", detail: "CODE_GITHUB_TOKEN can't see this repository.", fix: "In GitHub, add this repo to the CODE_GITHUB_TOKEN token with Actions: Read & write.", gate: true },
    missing: { id: "dispatch", label: "Run-starting credential reaches this repo", status: "blocked", detail: "CODE_GITHUB_TOKEN is not set in Jackboy.", gate: true },
  };
  items.push(dc[f.dispatchCredential]);

  const ct = f.codeTargets;
  items.push(!ct.present || !ct.parses
    ? { id: "targets", label: "CODE_TARGETS includes this site", status: "blocked", detail: ct.present ? "The saved CODE_TARGETS value isn't valid." : "CODE_TARGETS is not set.", fix: "Save the exact value shown below with the secure form.", gate: true }
    : ct.entry?.ref === "main" && ct.entry.workflowSha === sha
      ? { id: "targets", label: "CODE_TARGETS includes this site", status: "done", detail: `Lists ${f.repo} on main with workflow ${sha.slice(0, 12)}….`, gate: true }
      : { id: "targets", label: "CODE_TARGETS includes this site", status: "waiting", detail: ct.entry ? "CODE_TARGETS lists this site with a different workflow version." : "CODE_TARGETS doesn't list this site yet.", fix: "Save the exact value shown below with the secure form (ask in chat: \"open the CODE_TARGETS form\").", gate: true });

  items.push(!f.pinStorageReady
    ? { id: "storage", label: "Database ready for several sites", status: "blocked", detail: "The reviewed database update for multi-site pins isn't applied yet.", fix: "Approve the staged database update in chat.", gate: true }
    : f.pinned && f.pinned.workflowSha === sha
      ? { id: "storage", label: "Database ready for several sites", status: "done", detail: "Already pinned.", gate: true }
      : f.siteCount >= MAX_CODE_SITES
        ? { id: "storage", label: "Database ready for several sites", status: "blocked", detail: `The allow list already holds ${MAX_CODE_SITES} sites.`, fix: "Remove a site first.", gate: true }
        : { id: "storage", label: "Database ready for several sites", status: "done", detail: "Multi-site pins available.", gate: true });

  items.push(f.activeTask
    ? { id: "idle", label: "No CODE task running", status: "waiting", detail: "A CODE task is active; the allow list can't change mid-task.", fix: "Wait for it to finish.", gate: true }
    : { id: "idle", label: "No CODE task running", status: "done", detail: "Safe to change the allow list.", gate: true });

  items.push(f.pinned && f.pinned.workflowSha === sha && f.pinned.ref === "main"
    ? { id: "pin", label: "Pin active (your passkey)", status: "done", detail: `${f.repo} is on the CODE allow list.`, gate: false }
    : { id: "pin", label: "Pin active (your passkey)", status: "waiting", detail: "Not on the allow list yet.", fix: "When every line above passes, press Approve and activate with passkey.", gate: false });
  return items;
}

/** Plain reason activation is refused, or null when every gate passes. Re-run on the server right before the pin is written. */
export function activationBlockReason(items: CheckItem[]): string | null {
  const bad = items.find((i) => i.gate && i.status !== "done");
  return bad ? `${bad.label}: ${bad.detail}${bad.fix ? ` ${bad.fix}` : ""}` : null;
}

export type SitePhase = "not_started" | "prepared" | "ready" | "active" | "blocked";
export function sitePhase(items: CheckItem[]): SitePhase {
  if (items.find((i) => i.id === "pin")?.status === "done") return "active";
  if (items.find((i) => i.id === "profile")?.status === "blocked" || items.find((i) => i.id === "branch")?.status === "blocked") return "blocked";
  if (!activationBlockReason(items)) return "ready";
  const pr = items.find((i) => i.id === "pr");
  return pr?.detail.startsWith("No onboarding PR") ? "not_started" : "prepared";
}

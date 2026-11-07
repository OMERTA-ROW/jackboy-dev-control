// Pure rules for OMNI build/test handoffs. A handoff may be issued or used only when ALL hold:
// a fresh, configuration-matching live link; the owner acting on their own enrolled project;
// a current (unrevoked, unexpired) project authorization covering the job kind and repo;
// the Kill Switch off; and, when using an issued grant, that grant is still live.
// The database function `omni_dispatch_grant_action` enforces the same rules; this module
// explains them in plain words and is the app-side second check.
import { OMNI_VERIFICATION_MAX_AGE_MS } from "./omni-link";

export type HandoffKind = "code" | "test";
export const HANDOFF_KINDS: readonly HandoffKind[] = ["code", "test"];
export const HANDOFF_KIND_LABEL: Record<HandoffKind, string> = { code: "Build", test: "Test" };
/** Name OMNI sees on the wire. Jackboy stores builds as `code`. */
export const wireKind = (k: HandoffKind): "build" | "test" => (k === "code" ? "build" : "test");
export const isHandoffKind = (k: unknown): k is HandoffKind => k === "code" || k === "test";

export const MAX_PROJECT_AUTH_DAYS = 30;
export const DISPATCH_GRANT_MINUTES = 15;
/** Written by `isOmniVerified` when a link merely aged out. Only this reason does NOT revoke live grants. */
export const LINK_AGED_MESSAGE = "OMNI verification expired; check the link again.";
export const LINK_CONFIG_CHANGED_MESSAGE = "OMNI configuration changed since it was verified.";
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type HandoffFacts = {
  isOwner: boolean;
  actorId: string;
  killSwitchOn: boolean;
  link: { verified: boolean; verifiedAt: string | null; configMatches: boolean };
  project: { id: string; ownerId: string | null; enrolled: boolean; repoUrl: string | null } | null;
  job: {
    projectId: string | null;
    kind: string;
    status: string;
    sentAt: string | null;
    codeRequestId: string | null;
    repo: string | null;
    instructions: string;
  };
  authorization: {
    projectId: string;
    ownerId: string;
    kinds: string[];
    repo: string;
    expiresAt: string;
    revokedAt: string | null;
  } | null;
  grant?: { expiresAt: string; revokedAt: string | null } | null;
};

export type Blocker = { code: string; message: string };
export type HandoffVerdict = { allowed: boolean; blockers: Blocker[] };

export function linkIsLive(link: HandoffFacts["link"], now = Date.now()): boolean {
  if (!link.verified || !link.verifiedAt || !link.configMatches) return false;
  const at = Date.parse(link.verifiedAt);
  return Number.isFinite(at) && at <= now + 30_000 && now - at <= OMNI_VERIFICATION_MAX_AGE_MS;
}

export function authorizationIsCurrent(
  a: HandoffFacts["authorization"],
  scope: { actorId: string; projectId: string | null; kind: string; repo: string | null },
  now = Date.now(),
): boolean {
  if (!a || a.revokedAt || !scope.projectId || !scope.repo) return false;
  const exp = Date.parse(a.expiresAt);
  return (
    a.ownerId === scope.actorId &&
    a.projectId === scope.projectId &&
    a.repo === scope.repo &&
    a.kinds.includes(scope.kind) &&
    Number.isFinite(exp) &&
    exp > now
  );
}

/** `issue` = owner approving one exact job; `use` = sending, checking or recording with an issued grant. */
export function evaluateHandoff(f: HandoffFacts, stage: "issue" | "use", now = Date.now()): HandoffVerdict {
  const blockers: Blocker[] = [];
  const add = (code: string, message: string) => blockers.push({ code, message });
  const j = f.job;

  if (!f.isOwner) add("owner", "Only the owner can hand work to OMNI.");
  if (f.killSwitchOn) add("kill_switch", "The Kill Switch is on, so nothing is handed to OMNI.");

  if (!f.link.verified) add("link", "OMNI's live link is not verified. Press Check connection.");
  else if (!f.link.configMatches) add("link_config", "OMNI's settings changed since the last check. Check the connection again.");
  else if (!linkIsLive(f.link, now)) add("link_stale", "OMNI's link check is older than 5 minutes. Check the connection again.");

  if (!isHandoffKind(j.kind)) add("kind", "Only build and test jobs can be handed to OMNI.");
  if (j.status !== "queued" || j.sentAt) add("job_state", "This job is no longer waiting to be handed off.");
  if (j.codeRequestId) add("job_code", "CODE requests use their own approval path, not this handoff.");
  if (!j.repo || !REPO.test(j.repo)) add("job_repo", "This job has no GitHub repository.");
  const len = j.instructions.length;
  if (len < 3 || len > 4000) add("job_instructions", "Job instructions must be 3–4000 characters.");

  const p = f.project;
  if (!p || p.id !== j.projectId) add("project", "This job's project could not be found.");
  else {
    if (p.ownerId !== f.actorId) add("project_owner", "This project belongs to someone else.");
    if (!p.enrolled) add("project_enrolled", "This project is not enrolled yet.");
    if (j.repo && p.repoUrl !== `https://github.com/${j.repo}`)
      add("project_repo", "The job's repository doesn't match the project's linked repository.");
  }

  const a = f.authorization;
  if (!a) add("authorization", "OMNI has no access to this project yet. Press Give OMNI access with passkey.");
  else if (a.revokedAt) add("authorization_revoked", "You revoked OMNI's access to this project.");
  else if (!(Date.parse(a.expiresAt) > now)) add("authorization_expired", "OMNI's access to this project expired.");
  else if (!authorizationIsCurrent(a, { actorId: f.actorId, projectId: j.projectId, kind: j.kind, repo: j.repo }, now))
    add(
      "authorization_scope",
      `OMNI's access to this project doesn't cover ${isHandoffKind(j.kind) ? HANDOFF_KIND_LABEL[j.kind].toLowerCase() : "this"} jobs for this repository.`,
    );

  if (stage === "use") {
    const g = f.grant;
    if (!g) add("grant", "No approval exists for this exact job.");
    else if (g.revokedAt) add("grant_revoked", "The approval for this job was revoked.");
    else if (!(Date.parse(g.expiresAt) > now)) add("grant_expired", "The approval for this job expired. Approve it again.");
  }
  return { allowed: blockers.length === 0, blockers };
}

/** Validates an owner's project-authorization request before the passkey/database step. */
export function validateAuthorizationRequest(input: { kinds: string[]; days: number }): string | null {
  const kinds = [...new Set(input.kinds)];
  if (kinds.length === 0) return "Choose build, test or both.";
  if (!kinds.every(isHandoffKind)) return "Only build and test can be authorized.";
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_PROJECT_AUTH_DAYS)
    return `Access lasts 1–${MAX_PROJECT_AUTH_DAYS} days.`;
  return null;
}

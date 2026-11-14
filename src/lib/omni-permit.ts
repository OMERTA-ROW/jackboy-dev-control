// Pure rules for the Jackboy execution permit (omni.permit/v1). Jackboy is the final permission and
// Emergency Stop gate for OMNI autonomous/CODE execution: OMNI may run such a job only while it holds
// a fresh, signed Jackboy permit. Runtime-neutral (WebCrypto only).
import { hmacHex } from "./omni-link";
import { UUID } from "./omni-session";

export const PERMIT_CONTRACT = "omni.permit/v1";
export const SAFETY_CONTRACT = "omni.safety/v1";
export const PERMIT_ACTIONS = ["permit.request", "permit.release", "safety"] as const;
export type PermitAction = (typeof PERMIT_ACTIONS)[number];
/** Database caps the permit at 60 s; OMNI renews every 20 s and halts when it can't. */
export const PERMIT_TTL_SECONDS = 60;
export const PERMIT_RENEW_EVERY_SECONDS = 20;
export const SAFETY_VALID_SECONDS = 30;
/** Fixed by the owner; the database refuses any other values. */
export const OMNI_AUTONOMY_LIMITS = { dailyUsd: 5, perCallUsd: 0.5, perTaskUsd: 1 } as const;
export const AUTONOMY_STEP_UP_ACTION = "omni_autonomy";
export const autonomyTarget = (approvalId: string) => `omni-autonomy:${approvalId}`;
export const PERMIT_KINDS = ["autonomous", "code"] as const;

export function isPermitAction(value: unknown): value is PermitAction {
  return (PERMIT_ACTIONS as readonly unknown[]).includes(value);
}

const KEYS: Record<PermitAction, string[]> = {
  "permit.request": ["action", "digest", "estimateUsd", "jobId", "kind", "projectId"],
  "permit.release": ["action", "jobId", "projectId"],
  safety: ["action", "projectId"],
};

export type PermitInput =
  | { action: "permit.request"; jobId: string; kind: (typeof PERMIT_KINDS)[number]; digest: string; estimateUsd: number }
  | { action: "permit.release"; jobId: string }
  | { action: "safety" };

/** Strict shape check: exact keys per action, project bound to the configured link. */
export function parsePermitInput(input: unknown, projectId: string): { ok: true; value: PermitInput } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "invalid_request" };
  const o = input as Record<string, unknown>;
  if (!isPermitAction(o["action"])) return { ok: false, error: "action_denied" };
  const action = o["action"];
  if (Object.keys(o).sort().join(",") !== KEYS[action].join(",")) return { ok: false, error: "action_denied" };
  if (o["projectId"] !== projectId) return { ok: false, error: "project_denied" };
  if (action === "safety") return { ok: true, value: { action } };
  const jobId = o["jobId"];
  if (typeof jobId !== "string" || !UUID.test(jobId)) return { ok: false, error: "job_required" };
  if (action === "permit.release") return { ok: true, value: { action, jobId } };
  const kind = o["kind"], digest = o["digest"], estimateUsd = o["estimateUsd"];
  if (!(PERMIT_KINDS as readonly unknown[]).includes(kind)) return { ok: false, error: "scope_invalid" };
  if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) return { ok: false, error: "scope_invalid" };
  if (typeof estimateUsd !== "number" || !Number.isFinite(estimateUsd) || estimateUsd <= 0 || estimateUsd > OMNI_AUTONOMY_LIMITS.perTaskUsd)
    return { ok: false, error: "scope_invalid" };
  return { ok: true, value: { action, jobId, kind: kind as (typeof PERMIT_KINDS)[number], digest, estimateUsd } };
}

export type SignedPermitFields = {
  permitId: string;
  jobId: string;
  kind: string;
  digest: string;
  clientId: string;
  projectId: string;
  approvalId: string;
  expiresAt: string;
};
/** Canonical message OMNI workers verify independently of the transport proof. */
export function permitSigningMessage(p: SignedPermitFields): string {
  return [PERMIT_CONTRACT, p.permitId, p.jobId, p.kind, p.digest, p.clientId, p.projectId, p.approvalId, p.expiresAt].join("\n");
}
export function signPermit(secret: string, p: SignedPermitFields): Promise<string> {
  return hmacHex(secret, permitSigningMessage(p));
}

/** A permit is usable only while unexpired by the verifier's own clock. */
export function permitUsable(p: { status?: unknown; expiresAt?: unknown } | null | undefined, now = Date.now()): boolean {
  if (!p || p.status !== "active" || typeof p.expiresAt !== "string") return false;
  const t = Date.parse(p.expiresAt);
  return Number.isFinite(t) && t > now;
}

const REASONS: Record<string, string> = {
  kill_switch_on: "the System Kill Switch is on",
  emergency_stop_engaged: "the CODE Emergency Stop is engaged",
  code_disabled: "the saved CODE setting is off",
  not_authorized: "you have not authorized OMNI autonomous work in Jackboy (or it expired)",
  approval_expired: "the OMNI link approval (Step 7) has expired",
  owner_scope: "the OMNI project or owner no longer matches",
  scope_invalid: "the job kind, fingerprint or cost estimate is not allowed",
  scope_mismatch: "the job changed after its permit was issued",
  job_closed: "this job's permit was already closed",
  permit_lapsed: "OMNI did not renew the permit in time, so the job must stop",
  concurrency_limit: "another OMNI job already holds a permit",
  daily_limit: "today's $5 OMNI budget is used up ($1 is reserved per job)",
  session_expired_or_invalid: "OMNI's signed link session expired",
  step7_approval_expired: "the OMNI link approval (Step 7) is missing or expired",
  step8_proof_missing: "there is no passed self-test (Step 8) for the current approval",
  step9_handshake_missing: "OMNI has not completed a signed link handshake (Step 9) in the last 30 minutes",
  runner_unavailable: "the self-test runner is not configured",
  meter_untrusted: "the spend meter is not trusted right now",
  gateway_unenforced: "the spending guard is not enforced",
  fresh_passkey_required: "a fresh passkey check is required",
  project_scope: "the OMNI project is not yours or is inactive",
  authorization_revoked: "you revoked OMNI autonomous permission",
  authorization_replaced: "a newer authorization replaced it",
  not_renewed_in_time: "OMNI did not renew it in time",
  released_by_omni: "OMNI finished the job",
};
export function permitReasonText(reason: string | null | undefined): string {
  if (!reason) return "";
  return REASONS[reason] ?? `blocked (${reason})`;
}

export type AutonomyStatusInput = {
  /** true = permit tables readable; false = confirmed missing; null = could not read (blocked, not "missing"). */
  installed: boolean | null;
  linkConfigured: boolean;
  approval: { approvalId: string; expiresAt: string } | null;
  step8ProofAt: string | null;
  lastHandshakeAt: string | null;
  runnerReady: boolean;
  meterOk: boolean | null;
  guardEnforced: boolean | null;
  killSwitch: boolean | null;
  emergencyStop: boolean | null;
  codeEnabled: boolean | null;
  authorization: { expiresAt: string } | null;
};
export type Gate = { id: string; label: string; ok: boolean; detail: string };

/** What the owner sees before authorizing, and why OMNI can or cannot run right now. Unknown = blocked. */
export function autonomyGates(s: AutonomyStatusInput, now = Date.now()) {
  const approvalOk = !!s.approval && Date.parse(s.approval.expiresAt) > now && Date.parse(s.approval.expiresAt) <= now + 86_400_000;
  const handshakeOk = !!s.lastHandshakeAt && Date.parse(s.lastHandshakeAt) > now - 30 * 60_000;
  // A new handshake is refused by the database while the System Kill Switch is on, so say so.
  const handshakeHint = s.killSwitch === true ? " A new one is refused while the System Kill Switch is on." : " OMNI must run Step 9 again.";
  const handshakeDetail = !s.lastHandshakeAt
    ? `No handshake yet.${handshakeOk ? "" : handshakeHint}`
    : handshakeOk
      ? `Last handshake ${s.lastHandshakeAt}`
      : `Last handshake ${s.lastHandshakeAt} (over 30 minutes ago).${handshakeHint}`;
  const authorize: Gate[] = [
    {
      id: "installed",
      label: "Permit service installed",
      ok: s.installed === true,
      detail: s.installed === true ? "Ready" : s.installed === false ? "The database change is not installed yet" : "Couldn't read it right now (treated as blocked)",
    },
    { id: "link", label: "OMNI link set up in Jackboy", ok: s.linkConfigured, detail: s.linkConfigured ? "Link settings valid" : "Link off or settings invalid" },
    { id: "step7", label: "Step 7 approval window", ok: approvalOk, detail: s.approval ? `Ends ${s.approval.expiresAt}` : "No saved approval" },
    { id: "step8", label: "Step 8 self-test proof", ok: !!s.step8ProofAt, detail: s.step8ProofAt ? `Passed ${s.step8ProofAt}` : "No passed self-test for this approval" },
    { id: "step9", label: "Step 9 signed handshake (last 30 min)", ok: handshakeOk, detail: handshakeDetail },
    { id: "runner", label: "Self-test runner", ok: s.runnerReady, detail: s.runnerReady ? "Configured" : "Not configured" },
    { id: "meter", label: "Trusted spend meter", ok: s.meterOk === true, detail: s.meterOk === null ? "Unreadable" : s.meterOk ? "Trusted" : "Not trusted" },
    { id: "guard", label: "Spending guard", ok: s.guardEnforced === true, detail: s.guardEnforced === null ? "Unreadable" : s.guardEnforced ? "Enforced" : "Not enforced" },
  ];
  const authorized = !!s.authorization && Date.parse(s.authorization.expiresAt) > now;
  const run: Gate[] = [
    { id: "kill", label: "System Kill Switch off", ok: s.killSwitch === false, detail: s.killSwitch === null ? "Unreadable" : s.killSwitch ? "On" : "Off" },
    { id: "stop", label: "CODE Emergency Stop released", ok: s.emergencyStop === false, detail: s.emergencyStop === null ? "Unreadable" : s.emergencyStop ? "Engaged" : "Released" },
    { id: "code", label: "CODE setting on", ok: s.codeEnabled === true, detail: s.codeEnabled === null ? "Unreadable" : s.codeEnabled ? "On" : "Off" },
    { id: "auth", label: "Your Jackboy authorization", ok: authorized, detail: authorized ? `Until ${s.authorization!.expiresAt}` : "Not authorized" },
  ];
  return {
    authorize,
    run,
    canAuthorize: authorize.every((g) => g.ok),
    omniCanRun: s.installed === true && authorized && run.every((g) => g.ok) && authorize.slice(0, 3).every((g) => g.ok),
  };
}

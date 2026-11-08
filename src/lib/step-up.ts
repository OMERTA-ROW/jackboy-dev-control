// Passkey step-up policy. Identity (a fresh passkey assertion) and permission (role + action policy)
// are checked separately: a valid passkey never grants an action the role isn't allowed to do.
export const STEP_UP_ACTIONS = {
  remove_passkey: { label: "Remove one registered passkey", roles: ["owner"] },
  merge_update: { label: "Merge an update into the main branch", roles: ["owner"] },
  revert_update: { label: "Revert a merged update", roles: ["owner"] },
  critical_change: { label: "Critical Code Foundry change (security/config/destructive files)", roles: ["owner"] },
  approve_integration: { label: "Approve a provider permission for one project", roles: ["owner"] },
  omni_dispatch: { label: "Approve one OMNI build or test job for receipt only", roles: ["owner"] },
  omni_project_scope: { label: "Let OMNI receive build/test jobs for one project", roles: ["owner"] },
  omni_link_values: { label: "Show the OMNI link values (owner ID, approval ID, expiry) to copy into Railway", roles: ["owner"] },
  autonomy_toggle: { label: "Turn on background work or Autopilot", roles: ["owner"] },
  credential_change: { label: "Create or change a stored credential", roles: ["owner"] },
  owner_settings: { label: "Change an owner-only setting", roles: ["owner"] },
  global_pause: { label: "Turn the Kill Switch / Global Pause on or off", roles: ["owner"] },
  code_hard_cap: { label: "Mark or un-mark the CODE provider hard cap as verified", roles: ["owner"] },
  code_enable: { label: "Release the CODE stop and turn CODE on", roles: ["owner"] },
  code_site_pin: { label: "Add a site to the CODE allow list or remove it", roles: ["owner"] },
  task_step: { label: "Approve one Task Mode step", roles: ["owner"] },
  code_auto_lane: { label: "Turn the CODE automatic lane on or off for one site", roles: ["owner"] },
  code_undo: { label: "Undo a merged CODE change (Jackboy merges the revert after checks pass)", roles: ["owner"] },
  task_skip_rule: { label: "Change which task steps can skip approval", roles: ["owner"] },
  production_deploy: { label: "Production deployment", roles: ["owner"] },
  privilege_escalation: { label: "Grant or raise a permission", roles: ["owner", "admin"] },
  building_control: { label: "Physical building controls", roles: ["owner"], unavailable: "Future integration; not authorized or connected" },
} as const satisfies Record<string, { label: string; roles: readonly string[]; unavailable?: string }>;
export type StepUpAction = keyof typeof STEP_UP_ACTIONS;
export const GRANT_TTL_MS = 5 * 60_000;
export const CHALLENGE_TTL_MS = 2 * 60_000;

/** Permission check, independent of identity proof. */
export function mayRequest(action: string, role: string | null): { ok: true } | { ok: false; reason: string } {
  const a = (STEP_UP_ACTIONS as Record<string, { roles: readonly string[]; unavailable?: string }>)[action];
  if (!a) return { ok: false, reason: "Unknown action" };
  if ("unavailable" in a && a.unavailable) return { ok: false, reason: a.unavailable };
  if (!role || !a.roles.includes(role)) return { ok: false, reason: "Your role is not permitted to do this" };
  return { ok: true };
}

export type Grant = { user_id: string; action: string; target: string; expires_at: string; used_at: string | null };
/** A grant is usable once, by the same user, for the exact action and target, before it expires. */
export function grantUsable(g: Grant | null, userId: string, action: string, target: string, now = Date.now()): boolean {
  return !!g && g.user_id === userId && g.action === action && g.target === target && !g.used_at && new Date(g.expires_at).getTime() > now;
}

/** Recent verification: after a real passkey check, routine connection reviews can reuse it briefly.
 * Every reuse still mints a fresh single-use grant for the exact action+target; privileged actions
 * (merge, revert, deploy, critical changes, passkey removal, permission raises, package decisions) never qualify. */
export const RECENT_VERIFICATION_MS = 10 * 60_000;
const RECENT_TARGET_PREFIXES = ["repository_resync:", "github_repo:"] as const;
/** Sensitive-but-routine owner actions share the short grace window after a real passkey check. */
export const GRACE_ACTIONS = ["global_pause", "autonomy_toggle", "credential_change", "owner_settings"] as const;
export function recentEligible(action: string, target: string): boolean {
  if ((FRESH_ONLY_ACTIONS as readonly string[]).includes(action)) return false;
  if ((GRACE_ACTIONS as readonly string[]).includes(action)) return target.length > 0;
  return action === "approve_integration" && RECENT_TARGET_PREFIXES.some((p) => target.startsWith(p));
}
/** Actions that always need a new device ceremony: never grace-eligible, and reused grants are refused. */
export const FRESH_ONLY_ACTIONS = ["code_hard_cap", "code_enable", "code_site_pin", "task_step", "task_skip_rule", "code_auto_lane", "code_undo", "omni_dispatch", "omni_project_scope", "omni_link_values"] as const;
/** A grant minted by recent-verification reuse carries a "recent:" credential and is not fresh. */
export function grantIsFresh(g: { credential_id?: string | null } | null): boolean {
  return !!g && typeof g.credential_id === "string" && g.credential_id.length > 0 && !g.credential_id.startsWith("recent:");
}
/** True when the user's latest ceremony-backed grant is recent and its passkey is still registered. */
export function recentVerificationValid(last: { created_at: string; recent?: boolean } | null, keyStillRegistered: boolean, now = Date.now()): boolean {
  if (!last || !keyStillRegistered || last.recent) return false;
  return now - new Date(last.created_at).getTime() < RECENT_VERIFICATION_MS;
}

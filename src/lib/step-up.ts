// Passkey step-up policy. Identity (a fresh passkey assertion) and permission (role + action policy)
// are checked separately: a valid passkey never grants an action the role isn't allowed to do.
export const STEP_UP_ACTIONS = {
  remove_passkey: { label: "Remove one registered passkey", roles: ["owner"] },
  merge_update: { label: "Merge an update into the main branch", roles: ["owner"] },
  revert_update: { label: "Revert a merged update", roles: ["owner"] },
  critical_change: { label: "Critical Code Foundry change (security/config/destructive files)", roles: ["owner"] },
  approve_integration: { label: "Approve a provider permission for one project", roles: ["owner"] },
  production_deploy: { label: "Production deployment", roles: ["owner"], unavailable: "Not built: Jackboy has no deploy integration" },
  privilege_escalation: { label: "Grant or raise a permission", roles: ["owner"], unavailable: "Not built yet" },
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

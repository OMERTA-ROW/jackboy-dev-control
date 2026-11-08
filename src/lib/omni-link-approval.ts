// Which OMNI link approval (ID + expiry) Jackboy enforces. Precedence, fail closed:
// 1. Saved record could not be read  -> "unavailable": no approval, so the link refuses OMNI.
// 2. Saved record exists             -> "database": always wins, even when expired (never falls back).
// 3. No saved record                 -> "legacy_env": the old OMNI_LINK_APPROVAL_* project settings.
// The approval never turns the link on (OMNI_LINK_ENABLED does) and is not OMNI project access.
export type ApprovalSource = "database" | "legacy_env" | "unavailable";
export type SavedApproval = { approval_id: string; expires_at: string; saved_at: string };
export type EffectiveApproval = { source: ApprovalSource; approvalId: string; expiresAt: string; savedAt: string | null };

export const SAVE_APPROVAL_ACTION = "omni_link_approval_save";
export const SAVE_APPROVAL_TARGET = "omni-link-approval";

export function resolveApproval(
  read: { ok: true; row: SavedApproval | null } | { ok: false },
  env: Record<string, string | undefined>,
): EffectiveApproval {
  if (!read.ok) return { source: "unavailable", approvalId: "", expiresAt: "", savedAt: null };
  if (read.row) {
    const t = Date.parse(read.row.expires_at);
    return {
      source: "database",
      approvalId: read.row.approval_id,
      expiresAt: Number.isFinite(t) ? new Date(t).toISOString() : "",
      savedAt: read.row.saved_at,
    };
  }
  return {
    source: "legacy_env",
    approvalId: (env["OMNI_LINK_APPROVAL_ID"] ?? "").trim(),
    expiresAt: (env["OMNI_LINK_APPROVAL_EXPIRES_AT"] ?? "").trim(),
    savedAt: null,
  };
}

/** The env view every check uses, with the approval replaced by the effective one. */
export function withApproval<T extends Record<string, string | undefined>>(env: T, a: EffectiveApproval): T {
  return { ...env, OMNI_LINK_APPROVAL_ID: a.approvalId || undefined, OMNI_LINK_APPROVAL_EXPIRES_AT: a.expiresAt || undefined };
}

export const APPROVAL_SOURCE_TEXT: Record<ApprovalSource, string> = {
  database: "Saved in Jackboy with your passkey (this overrides the old project settings)",
  legacy_env: "Old project settings (OMNI_LINK_APPROVAL_* in Secrets) — no passkey-saved approval yet",
  unavailable: "Could not read the saved approval — the link refuses OMNI until it can",
};

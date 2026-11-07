// Pure rules for showing who did each audit-log action. The audit log itself is append-only in
// the database (triggers reject update/delete/truncate); this only formats rows for display.

export type AttributedRow = {
  id: string;
  at: string;
  actor: string | null;
  actor_role: "owner" | "admin" | "member" | null;
  actor_email: string | null;
  action: string;
  outcome: string;
  detail: unknown;
};

/** "You (owner)", "jane@x.com (admin)", "Former member · 1a2b3c4d" or "System (no signed-in person)". */
export function actorLabel(r: Pick<AttributedRow, "actor" | "actor_role" | "actor_email">, me: string | null): string {
  if (!r.actor) return "System (no signed-in person)";
  const role = r.actor_role ?? null;
  if (r.actor === me) return role ? `You (${role})` : "You";
  if (!role) return `Former member · ${r.actor.slice(0, 8)}`;
  return r.actor_email ? `${r.actor_email} (${role})` : `${role[0]!.toUpperCase()}${role.slice(1)} · ${r.actor.slice(0, 8)}`;
}

const PREFIX: [string, string][] = [
  ["stepup.granted", "Passkey confirmed"],
  ["stepup.denied", "Passkey refused"],
  ["passkey.", "Passkey"],
  ["dev.activate", "Background work switched"],
  ["hub.project.", "Project hub"],
  ["projects.", "Project"],
  ["autopilot.", "Autopilot"],
  ["updates.", "Update"],
  ["github.", "GitHub"],
  ["automation.", "Automation policy"],
  ["chat.", "Chat"],
  ["code.", "CODE"],
  ["action.", "Action request"],
  ["alerts.", "Phone alerts"],
  ["agent.", "Agent"],
  ["guardian.", "Guardian"],
];

/** Plain area name for an action code; unknown codes are shown as-is, never hidden. */
export function actionArea(action: string): string {
  for (const [p, label] of PREFIX) if (action === p || action.startsWith(p)) return label;
  return action;
}

/** Short, readable detail: key=value pairs, long values trimmed. */
export function detailLine(detail: unknown, max = 160): string {
  if (detail == null || typeof detail !== "object") return detail == null ? "" : String(detail).slice(0, max);
  const s = Object.entries(detail as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

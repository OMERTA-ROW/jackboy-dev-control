// Plain-language view of the Guardian rules that already exist in code (guardian.ts, automation-policy.ts,
// voice-guard.ts, global-pause.ts, omni-jobs.ts). Pure and read-only: nothing here changes what Guardian allows.
import { AUTONOMY, CAPABILITIES, OWNER_ONLY } from "./guardian";
import { HIGH_RISK, TIERS } from "./automation-policy";
import { TOOL_RISK } from "./voice-guard";

export type GuardianScope = {
  id: string;
  label: string;
  detail: string;
  to: "/fleet" | "/automation" | "/omni" | "/chat" | "/settings";
};

/** What Guardian currently protects, each tied to the code path that enforces it. */
export const GUARDIAN_SCOPES: GuardianScope[] = [
  {
    id: "agents",
    label: "Agent actions",
    to: "/fleet",
    detail:
      "Every agent action is checked before it runs. Anything not explicitly allowed is refused.",
  },
  {
    id: "automation",
    label: "Merges and deployments",
    to: "/automation",
    detail:
      "Decides whether a change may be approved automatically or must go to you. Production always goes to you.",
  },
  {
    id: "omni",
    label: "OMNI jobs",
    to: "/omni",
    detail:
      "Jobs sent to OMNI stop when the Kill Switch is on, and only go to allowed repositories. OMNI never pushes or deploys.",
  },
  {
    id: "chat",
    label: "Chat and voice tools",
    to: "/chat",
    detail:
      "A spoken 'yes' never counts as approval for changes; permission changes must be typed or done on the page.",
  },
];

export type GuardianRule = { group: string; text: string };

/** Rules derived from the live code constants so this list can never drift from what is enforced. */
export function guardianRules(): GuardianRule[] {
  const ownerOnly = CAPABILITIES.filter((c) => OWNER_ONLY.includes(c.id)).map((c) =>
    c.label.toLowerCase(),
  );
  const sensitiveTools = Object.entries(TOOL_RISK).filter(([, r]) => r === "sensitive").length;
  return [
    {
      group: "Everywhere",
      text: "The Kill Switch beats every other setting. If it is on, or its state can't be read, no work starts.",
    },
    {
      group: "Agent actions",
      text: "Refused by default: an action runs only if every check below passes.",
    },
    {
      group: "Agent actions",
      text: "Refused if the agent is paused, its passport isn't approved by you, or it isn't verified as installed.",
    },
    {
      group: "Agent actions",
      text: "An agent may only act on its own project — never on another project.",
    },
    {
      group: "Agent actions",
      text: "Refused if the connection the action needs (search, sandbox, repository, OMNI) isn't verified.",
    },
    { group: "Agent actions", text: `Always needs you: ${ownerOnly.join(", ")}.` },
    {
      group: "Agent actions",
      text: `Freedom levels: ${AUTONOMY.map((a) => `${a.label} (${a.detail.replace(/\.$/, "")})`).join("; ")}.`,
    },
    {
      group: "Merges and deployments",
      text: `Always needs you, at every level: production deploys and changes touching ${HIGH_RISK.join(", ")}.`,
    },
    {
      group: "Merges and deployments",
      text: "Automatic approval also needs: Guardian verified, passing tests, a protected branch, a rollback plan, and a change within the size limits.",
    },
    {
      group: "Merges and deployments",
      text: "Nothing is ever merged or published without your approval in the CODE flow.",
    },
    {
      group: "OMNI jobs",
      text: "Jobs go only to allowed repositories. OMNI clones, applies an optional patch and runs tests — it never pushes or deploys.",
    },
    {
      group: "Chat and voice tools",
      text: `Spoken approvals can't run change tools; ${sensitiveTools} permission/automation tools must be typed or switched on the page.`,
    },
  ];
}

export const TIER_OPTIONS = TIERS;

export type GuardianState = "on" | "held";
/** Guardian's checks are built into the code and cannot be switched off. "held" = Kill Switch on or unreadable. */
export function guardianStatus(
  p: { paused?: unknown } | null | undefined,
  guardianVerified: boolean,
) {
  const unreadable = !p || typeof p.paused !== "boolean";
  const held = unreadable || p.paused === true;
  return {
    state: (held ? "held" : "on") as GuardianState,
    headline: unreadable
      ? "Guardian is on — Kill Switch state can't be read, so all work is held."
      : p.paused
        ? "Guardian is on — Kill Switch is on, so all work is paused."
        : "Guardian is on — every protected action is checked before it runs.",
    approver: guardianVerified
      ? "Guardian may auto-approve small low-risk changes within your limits."
      : "Guardian is not verified as an approver, so it can't approve anything on its own — every merge and deploy comes to you.",
  };
}

export type Verdict = "allowed" | "blocked" | "flagged";
export type GuardianEvent = {
  id: string;
  at: string;
  verdict: Verdict;
  area: string;
  reason: string;
};

/** Audit actions that record a Guardian-style decision. */
export const AUDIT_ACTIONS = [
  "guardian.check",
  "chat.voice_blocked",
  "automation.decision",
  "automation.policy",
  "stepup.denied",
  "updates.merge_blocked",
  "action.deny",
  "worker.kill_switch",
  "worker.kill_switch_off",
] as const;
/** Site-log actions that record a Guardian-style decision. */
export const SITE_ACTIONS = [
  "omni.chat_job.refused",
  "omni.chat_job.submitted",
  "omni.link.denied",
  "omni.link.refused",
  "foundry.transition:blocked",
  "foundry.inspect_blocked",
  "task.stopped",
] as const;

type Fields = {
  name?: unknown;
  action?: unknown;
  reason?: unknown;
  reasons?: unknown;
  route?: unknown;
  tool?: unknown;
  tier?: unknown;
  max_files?: unknown;
  max_lines?: unknown;
  paused?: unknown;
  title?: unknown;
};
type Detail = unknown;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function classifyAudit(row: {
  id: string;
  at: string;
  action: string;
  outcome: string | null;
  detail: Detail;
}): GuardianEvent | null {
  const d: Fields =
    row.detail && typeof row.detail === "object" && !Array.isArray(row.detail)
      ? (row.detail as Fields)
      : {};
  const base = { id: `a-${row.id}`, at: row.at };
  switch (row.action) {
    case "guardian.check":
      return {
        ...base,
        area: "Agent actions",
        verdict: row.outcome === "allow" ? "allowed" : "blocked",
        reason: `${str(d.name) ?? "Agent"} · ${str(d.action) ?? "action"}: ${str(d.reason) ?? "no reason recorded"}`,
      };
    case "chat.voice_blocked":
      return {
        ...base,
        area: "Chat and voice tools",
        verdict: "blocked",
        reason: `Spoken request for "${str(d.tool) ?? "a change tool"}" refused — voice isn't approval.`,
      };
    case "automation.decision": {
      const route = str(d.route) ?? row.outcome;
      const reasons = Array.isArray(d.reasons)
        ? d.reasons.filter((x) => typeof x === "string").join(" ")
        : "";
      return {
        ...base,
        area: "Merges and deployments",
        verdict: route === "guardian" ? "allowed" : route === "blocked" ? "blocked" : "flagged",
        reason:
          route === "owner"
            ? `Sent to you: ${reasons || "needs owner approval."}`
            : reasons || "Decision recorded.",
      };
    }
    case "automation.policy":
      return {
        ...base,
        area: "Settings",
        verdict: "flagged",
        reason: `Settings changed: approval level ${d.tier ?? "?"}, limit ${d.max_files ?? "?"} files / ${d.max_lines ?? "?"} lines, Kill Switch ${d.paused ? "on" : "off"}.`,
      };
    case "stepup.denied":
      return {
        ...base,
        area: "Passkey checks",
        verdict: "blocked",
        reason: str(d.reason) ?? "Passkey confirmation refused.",
      };
    case "updates.merge_blocked":
      return {
        ...base,
        area: "Merges and deployments",
        verdict: "blocked",
        reason: str(d.reason) ?? "Merge blocked.",
      };
    case "action.deny":
      return {
        ...base,
        area: "Approvals",
        verdict: "blocked",
        reason: str(d.reason) ?? str(d.title) ?? "Action denied by owner.",
      };
    case "worker.kill_switch":
      return { ...base, area: "Kill Switch", verdict: "flagged", reason: "Kill Switch turned on." };
    case "worker.kill_switch_off":
      return {
        ...base,
        area: "Kill Switch",
        verdict: "flagged",
        reason: "Kill Switch turned off.",
      };
    default:
      return null;
  }
}

export function classifySite(row: {
  id: string | number;
  at: string;
  action: string;
  status: string | null;
  summary: string | null;
}): GuardianEvent | null {
  if (!(SITE_ACTIONS as readonly string[]).includes(row.action)) return null;
  const omni = row.action.startsWith("omni.");
  const allowed = row.action === "omni.chat_job.submitted";
  return {
    id: `s-${row.id}`,
    at: row.at,
    area: omni ? "OMNI jobs" : row.action.startsWith("foundry") ? "Code Foundry" : "Tasks",
    verdict: allowed ? "allowed" : "blocked",
    reason: str(row.summary) ?? row.action,
  };
}

/** Newest first, de-duplicated by id, capped. */
export function mergeEvents(
  lists: Array<Array<GuardianEvent | null>>,
  limit = 40,
): GuardianEvent[] {
  const seen = new Set<string>();
  return lists
    .flat()
    .filter((e): e is GuardianEvent => !!e && !seen.has(e.id) && (seen.add(e.id), true))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit);
}

/** Owner-adjustable limits are the existing automation policy fields; ranges match the server validator. */
export function validLimits(v: {
  tier: number;
  maxFiles: number;
  maxLines: number;
}): string | null {
  if (![0, 1, 2].includes(v.tier)) return "Approval level must be 0, 1 or 2.";
  if (!Number.isInteger(v.maxFiles) || v.maxFiles < 1 || v.maxFiles > 20)
    return "Files limit must be 1–20.";
  if (!Number.isInteger(v.maxLines) || v.maxLines < 1 || v.maxLines > 500)
    return "Lines limit must be 1–500.";
  return null;
}

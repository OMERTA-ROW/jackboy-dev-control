// GuardianPolicy for spoken chat (first implementation of agent-contracts.ts).
// Voice is intent, never identity proof. Generic confirmations never release change tools.
import type { ToolRisk } from "./agent-contracts";

/** Risk per chat tool. "bounded" = reviewable/reversible (queue, branch, draft PR, read-only scan). "sensitive" = changes permissions or automation scope. */
export const TOOL_RISK: Record<string, ToolRisk> = {
  scanSite: "bounded", fixIssue: "bounded", writeFile: "bounded", openDraftPR: "bounded",
  foundryInspect: "bounded", foundryDecide: "bounded", saveMemory: "bounded",
  setAutopilot: "sensitive", linkRepo: "sensitive", setDevEnabled: "sensitive",
};
export const PRIVILEGED_TOOLS = Object.keys(TOOL_RISK);

type Msg = { role: string; metadata?: unknown; parts?: Array<{ type: string; text?: string }> };

export const isVoice = (m: Msg | undefined) => Boolean(m && (m.metadata as { voice?: unknown } | undefined)?.voice === true);
export const isConfirmation = (t: string) => /^\s*(yes[,.!]?\s+)?(i\s+)?(confirm(ed)?|approve(d)?)\b[.!]?\s*$/i.test(t);

export type Decision = { allow: true } | { allow: false; reason: string };

/** Legacy change tools stay blocked for voice. CODE uses a separate server-persisted request, nonce and session binding. Voice never satisfies passkey step-up. */
export function decideTool(tool: string, messages: Msg[]): Decision {
  const risk = TOOL_RISK[tool];
  if (!risk) return { allow: true };
  const users = messages.filter((m) => m.role === "user");
  const last = users.at(-1);
  if (!last) return { allow: false, reason: "No owner request." };
  if (!isVoice(last)) return { allow: true };
  if (risk === "sensitive") return { allow: false, reason: "Spoken approval can't change permissions or automation. Ask the owner to type the request, or use the switch on the page." };
  return { allow: false, reason: "Spoken yes/confirm is not a scoped authorization. Use the pending action's approval card. For CODE, name the pending request ID; its nonce, expiry and authenticated session are verified by the CODE endpoint." };
}

/** Back-compat check for the legacy scan tool. CODE has its own scoped authorization boundary. */
export const privilegedAllowed = (messages: Msg[]) => decideTool("scanSite", messages).allow;

/** Strip anything that looks like a secret from a transcript before it is shown, sent or spoken. */
export function redactTranscript(t: string): string {
  return t
    .replace(/\b(password|passcode|pin|token|api key|secret)\s*(is|:)?\s*\S+/gi, "$1 [hidden]")
    .replace(/\b(sk|pk|ghp|gho|github_pat|sb_secret|sb_publishable)_[A-Za-z0-9_]{8,}\b/g, "[hidden]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[hidden]");
}

/** Live voice: every user turn is spoken. Converts relay transcript messages into guard input. */
export function liveMessagesForGuard(messages: Array<{ role: string; content: unknown }>): Msg[] {
  return messages.filter((m) => m.role === "user").map((m) => ({ role: "user", metadata: { voice: true }, parts: [{ type: "text", text: typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c: { text?: string }) => c.text ?? "").join(" ") : "" }] }));
}


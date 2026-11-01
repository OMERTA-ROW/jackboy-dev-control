// Pure rules for spoken chat: privileged tools never run on a voice message alone unless it is an explicit confirmation.

export const PRIVILEGED_TOOLS = ["linkRepo", "writeFile", "openDraftPR", "scanSite", "fixIssue", "setAutopilot"] as const;

type Msg = { role: string; metadata?: unknown; parts?: Array<{ type: string; text?: string }> };

const textOf = (m: Msg) => (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ").trim();
export const isVoice = (m: Msg | undefined) => Boolean(m && (m.metadata as { voice?: unknown } | undefined)?.voice === true);
export const isConfirmation = (t: string) => /^\s*(yes[,.!]?\s+)?(i\s+)?confirm(ed)?\b[.!]?\s*$/i.test(t);

/** Privileged tools are allowed when the latest owner message was typed, or is a spoken explicit "confirm" replying to a prior request. */
export function privilegedAllowed(messages: Msg[]): boolean {
  const users = messages.filter((m) => m.role === "user");
  const last = users.at(-1);
  if (!last) return false;
  if (!isVoice(last)) return true;
  return isConfirmation(textOf(last)) && users.length >= 2;
}

import type { ChatMode, Conversation, StoredMessage } from "./chat-history";

export function messageTime(message: StoredMessage): number | null {
  const value = (message.metadata as { createdAt?: unknown } | undefined)?.createdAt;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** A fork is historical context, never a replayable tool call or approval grant. */
export function forkConversation(messages: StoredMessage[], throughId: string, mode: ChatMode, id: string, now: number): Conversation {
  const end = messages.findIndex((m) => m.id === throughId);
  if (end < 0) throw new Error("This message is no longer available.");
  const context = messages.slice(0, end + 1).map((m) => ({
    id: `${id}:${m.id}`, role: m.role,
    parts: m.parts.flatMap((p) => {
      const part = p as { type?: string; text?: string };
      if (part.type === "text" || part.type === "file") return [structuredClone(p)];
      if (part.type?.startsWith("tool-") || part.type === "dynamic-tool") return [{ type: "text", text: "[Historical tool activity: see the original conversation for results and approvals. Not rerun.]" }];
      return [];
    }),
    metadata: { ...(messageTime(m) ? { createdAt: messageTime(m) } : {}), historical: true },
  }));
  const first = context.find((m) => m.role === "user");
  const text = first?.parts.map((p) => (p as { text?: string }).text ?? "").join(" ") ?? "Conversation";
  return { id, mode, title: `Branch · ${text.slice(0, 45)}`, updatedAt: now, messages: context };
}

/** Retry restores the same input for review, never sends to the tool-enabled transport. */
export function retryDraft(messages: StoredMessage[], responseId: string): { throughId: string; text: string } | null {
  const index = messages.findIndex((m) => m.id === responseId);
  if (index < 0) return null;
  const request = messages.slice(0, index + 1).reverse().find((m) => m.role === "user");
  if (!request) return null;
  return { throughId: request.id, text: request.parts.map((p) => (p as { type?: string }).type === "text" ? (p as { text: string }).text : "").join(" ") };
}

/** Response space shrinks as the reply grows, keeping the document height stable. */
export function responseReserve(usableHeight: number, messageHeight: number): number {
  return Math.max(0, usableHeight / 2 - Math.min(messageHeight, usableHeight / 2));
}
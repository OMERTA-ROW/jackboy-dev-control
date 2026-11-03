// Per-account conversation history in this browser. Keys include the signed-in user id, so
// another account on the same device never reads it. Nothing is sent to other users.
export type ChatMode = "chat" | "code";
export type StoredMessage = { id: string; role: "user" | "assistant" | "system"; parts: unknown[]; metadata?: unknown };
export type Conversation = { id: string; mode: ChatMode; title: string; updatedAt: number; messages: StoredMessage[] };
export const MAX_CONVERSATIONS = 50;
export const MAX_MESSAGES = 120;

export const historyKey = (userId: string) => `jackboy.conversations.v1.${userId}`;

type Store = Pick<Storage, "getItem" | "setItem">;
export function loadConversations(store: Store, userId: string): Conversation[] {
  try {
    const raw = JSON.parse(store.getItem(historyKey(userId)) ?? "[]");
    return Array.isArray(raw) ? (raw as Conversation[]).filter((c) => c && typeof c.id === "string") : [];
  } catch { return []; }
}
export function titleFrom(messages: StoredMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const t = (first?.parts ?? []).map((p) => (p as { type?: string; text?: string }).type === "text" ? (p as { text: string }).text : "").join(" ").trim();
  return redact(t).slice(0, 60) || "New conversation";
}
/** Strip anything that looks like a credential before it is stored as a visible title. */
export function redact(s: string): string {
  return s.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[hidden]");
}
export function upsertConversation(list: Conversation[], c: Conversation): Conversation[] {
  const next = [{ ...c, messages: c.messages.slice(-MAX_MESSAGES) }, ...list.filter((x) => x.id !== c.id)];
  return next.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS);
}
export function saveConversations(store: Store, userId: string, list: Conversation[]) {
  try { store.setItem(historyKey(userId), JSON.stringify(list)); } catch { /* storage full: keep in memory */ }
}

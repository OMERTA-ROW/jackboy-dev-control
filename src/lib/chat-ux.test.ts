import { describe, it, expect } from "vitest";
import { deriveActivity } from "./chat-status";
import { historyKey, loadConversations, saveConversations, upsertConversation, titleFrom, MAX_CONVERSATIONS } from "./chat-history";

const future = new Date(Date.now() + 60_000).toISOString();
describe("activity indicator", () => {
  it("shows nothing when no real event", () => expect(deriveActivity({ chatStatus: "ready" })).toBeNull());
  it("thinking only while the chat stream is active", () => {
    expect(deriveActivity({ chatStatus: "submitted" })).toBe("thinking");
    expect(deriveActivity({ chatStatus: "streaming" })).toBe("thinking");
  });
  it("awaiting approval for unexpired pending CODE card only", () => {
    expect(deriveActivity({ cards: [{ status: "pending", expiresAt: future }] })).toBe("awaiting_approval");
    expect(deriveActivity({ cards: [{ status: "pending", expiresAt: "2000-01-01T00:00:00Z" }] })).toBeNull();
  });
  it("testing vs coding from real run jobs", () => {
    const run = (name: string) => ({ status: "allowed", expiresAt: future, run: { status: "in_progress", jobs: [{ name, status: "in_progress" }] } });
    expect(deriveActivity({ cards: [run("Run tests")] })).toBe("testing");
    expect(deriveActivity({ cards: [run("Apply patch")] })).toBe("coding");
  });
  it("working only while a real tool call runs", () => {
    expect(deriveActivity({ toolRunning: true, chatStatus: "streaming" })).toBe("working");
    expect(deriveActivity({ toolRunning: false, chatStatus: "streaming" })).toBe("thinking");
  });
  it("error and listening take priority", () => {
    expect(deriveActivity({ error: true, listening: true })).toBe("error");
    expect(deriveActivity({ listening: true, chatStatus: "streaming" })).toBe("listening");
  });
});

function mem() { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; }
describe("conversation history", () => {
  it("is isolated per account", () => {
    const s = mem();
    saveConversations(s, "userA", [{ id: "1", mode: "chat", title: "a", updatedAt: 1, messages: [] }]);
    expect(loadConversations(s, "userA")).toHaveLength(1);
    expect(loadConversations(s, "userB")).toHaveLength(0);
    expect(historyKey("userA")).not.toBe(historyKey("userB"));
  });
  it("caps list size and puts newest first", () => {
    let list: ReturnType<typeof loadConversations> = [];
    for (let i = 0; i < MAX_CONVERSATIONS + 5; i++) list = upsertConversation(list, { id: String(i), mode: "chat", title: "", updatedAt: i, messages: [] });
    expect(list).toHaveLength(MAX_CONVERSATIONS);
    expect(list[0]!.id).toBe(String(MAX_CONVERSATIONS + 4));
  });
  it("titles never contain tokens", () => {
    expect(titleFrom([{ id: "m", role: "user", parts: [{ type: "text", text: "use ghp_abcdefghijklmnopqrstuvwxyz123456 now" }] }])).toContain("[hidden]");
  });
  it("corrupt storage yields empty list", () => {
    const s = mem(); s.setItem(historyKey("u"), "{bad");
    expect(loadConversations(s, "u")).toEqual([]);
  });
});

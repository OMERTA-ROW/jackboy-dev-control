import { describe, expect, it } from "vitest";
import { forkConversation, messageTime, responseReserve, retryDraft } from "./chat-workflow";
import type { StoredMessage } from "./chat-history";

const messages: StoredMessage[] = [
  { id: "u", role: "user", parts: [{ type: "text", text: "CODE Omni: repair" }], metadata: { createdAt: 1793762280000 } },
  { id: "a", role: "assistant", parts: [{ type: "text", text: "Waiting for approval" }, { type: "tool-execute", toolCallId: "privileged", state: "approval-requested" }], metadata: { createdAt: 1793762281000, grant: "must-not-copy" } },
];
describe("frontend conversation safety", () => {
  it("forks context into CODE without tool calls, grants, or modifying the original", () => {
    const branch = forkConversation(messages, "a", "code", "fork", 1793762282000);
    expect(branch.mode).toBe("code");
    expect(branch.messages[1]?.parts.some((p) => (p as { type: string }).type.startsWith("tool-"))).toBe(false);
    expect(branch.messages[1]?.metadata).not.toHaveProperty("grant");
    expect(messages[1]?.parts).toHaveLength(2);
    expect(branch.messages[0]?.id).not.toBe("u");
  });
  it("restores the identical consequential request as an unsent draft", () => {
    expect(retryDraft(messages, "a")).toEqual({ throughId: "u", text: "CODE Omni: repair" });
    expect(retryDraft(messages, "missing")).toBeNull();
  });
  it("preserves actual timestamps and never invents legacy times", () => {
    expect(messageTime(forkConversation(messages, "a", "chat", "b", 99).messages[0] as StoredMessage)).toBe(1793762280000);
    expect(messageTime({ id: "old", role: "user", parts: [] })).toBeNull();
  });
  it("reserves half the usable viewport after short submits but not oversized commands", () => {
    expect(responseReserve(600, 80)).toBe(220);
    expect(responseReserve(600, 900)).toBe(0);
    expect(Math.max(0, responseReserve(600, 80) - 150)).toBe(70);
  });
});
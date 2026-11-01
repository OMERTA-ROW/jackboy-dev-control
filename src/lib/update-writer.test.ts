import { describe, expect, it } from "vitest";
import { canTransition, isDue, parseProposal } from "./update-writer";

describe("update writer rules", () => {
  it("daily schedule is due after 24h, not after 1h", () => {
    const now = Date.parse("2026-11-02T12:00:00Z");
    expect(isDue(24, "2026-11-01T12:00:00Z", now)).toBe(true);
    expect(isDue(24, "2026-11-02T11:00:00Z", now)).toBe(false);
  });
  it("frequency 0 never runs on schedule", () => expect(isDue(0, null)).toBe(false));
  it("only approved proposals can be marked sent to OMNI", () => {
    expect(canTransition("draft", "sent_to_omni")).toBe(false);
    expect(canTransition("approved", "sent_to_omni")).toBe(true);
    expect(canTransition("sent_to_omni", "draft")).toBe(false);
  });
  it("rejects AI output missing a build prompt", () => {
    expect(() => parseProposal(JSON.stringify({ title: "a", what_to_change: "b", why: "c" }))).toThrow();
  });
});

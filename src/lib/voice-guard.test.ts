import { describe, expect, it } from "vitest";
import { isConfirmation, privilegedAllowed } from "./voice-guard";

const u = (text: string, voice = false) => ({ role: "user", metadata: voice ? { voice: true } : undefined, parts: [{ type: "text", text }] });

describe("voice guard", () => {
  it("allows privileged tools for typed messages", () => expect(privilegedAllowed([u("fix the footer")])).toBe(true));
  it("blocks privileged tools for a spoken command", () => expect(privilegedAllowed([u("turn off autopilot", true)])).toBe(false));
  it("allows a spoken confirm after a prior request", () => expect(privilegedAllowed([u("turn off autopilot", true), { role: "assistant", parts: [] }, u("confirm", true)])).toBe(true));
  it("does not accept a spoken confirm with no prior request", () => expect(privilegedAllowed([u("confirm", true)])).toBe(false));
  it("does not treat confirm buried in a sentence as confirmation", () => expect(isConfirmation("confirm and also delete everything")).toBe(false));
  it("accepts 'yes, confirm'", () => expect(isConfirmation("Yes, confirm.")).toBe(true));
  it("blocks with no messages", () => expect(privilegedAllowed([])).toBe(false));
});

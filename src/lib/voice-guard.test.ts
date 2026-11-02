import { describe, expect, it } from "vitest";
import { decideTool, isConfirmation, privilegedAllowed, redactTranscript } from "./voice-guard";
import { jackboyPolicy } from "./agent-contracts";

const u = (text: string, voice = false) => ({ role: "user", metadata: voice ? { voice: true } : undefined, parts: [{ type: "text", text }] });
const a = { role: "assistant", parts: [] };

describe("voice guard", () => {
  it("allows privileged tools for typed messages", () => expect(privilegedAllowed([u("fix the footer")])).toBe(true));
  it("blocks bounded tools for a spoken command", () => expect(decideTool("scanSite", [u("scan jackboy", true)]).allow).toBe(false));
  it("unbound spoken confirm never releases bounded tools", () => expect(decideTool("scanSite", [u("scan jackboy", true), a, u("confirm", true)]).allow).toBe(false));
  it("unbound spoken approve never releases bounded tools", () => expect(decideTool("openDraftPR", [u("open the PR", true), a, u("approve", true)]).allow).toBe(false));
  it("spoken approve never releases sensitive tools", () => expect(decideTool("setAutopilot", [u("turn off autopilot", true), a, u("approve", true)]).allow).toBe(false));
  it("typed request releases sensitive tools", () => expect(decideTool("setAutopilot", [u("turn off autopilot")]).allow).toBe(true));
  it("does not accept a spoken confirm with no prior request", () => expect(privilegedAllowed([u("confirm", true)])).toBe(false));
  it("does not treat confirm buried in a sentence as confirmation", () => expect(isConfirmation("confirm and also delete everything")).toBe(false));
  it("accepts 'yes, confirm'", () => expect(isConfirmation("Yes, confirm.")).toBe(true));
  it("blocks with no messages", () => expect(privilegedAllowed([])).toBe(false));
  it("read tools are always allowed", () => expect(decideTool("projectStatus", [u("status", true)]).allow).toBe(true));
});

describe("transcript redaction", () => {
  it("hides spoken passwords", () => expect(redactTranscript("my password is hunter2 ok")).toBe("my password [hidden] ok"));
  it("hides GitHub tokens", () => expect(redactTranscript("use ghp_abcdefghijklmnop")).toBe("use [hidden]"));
});

describe("policy contract", () => {
  it("forbids sensitive actions by voice", () => expect(jackboyPolicy.requiredStepUp("sensitive", "voice")).toBe("forbidden"));
  it("production deploys need passkey step-up", () => expect(jackboyPolicy.requiredStepUp("production", "text")).toBe("passkey"));
});


import { describe, it, expect } from "vitest";
import { decideTool, liveMessagesForGuard } from "./voice-guard";

const live = (...turns: string[]) => liveMessagesForGuard(turns.map((t, i) => ({ role: i % 2 ? "assistant" : "user", content: t })));

describe("live voice → same tools, guarded", () => {
  it("read-only tools run straight from voice", () => {
    expect(decideTool("connectionStatus", live("what's OMNI's connection status")).allow).toBe(true);
    expect(decideTool("foundryQueue", live("what's in the queue")).allow).toBe(true);
  });
  it("a generic confirmation cannot authorize a spoken change", () => {
    expect(decideTool("foundryInspect", live("inspect OMNI")).allow).toBe(false);
    expect(decideTool("foundryInspect", live("inspect OMNI", "I'll run a Code Foundry inspection on OMNI. Say confirm.", "confirm")).allow).toBe(false);
  });
  it("approving a task by voice also needs confirm", () => {
    expect(decideTool("foundryDecide", live("approve that task")).allow).toBe(false);
  });
  it("voice never toggles automation or permissions, even after confirm", () => {
    for (const t of ["setDevEnabled", "setAutopilot", "linkRepo"]) expect(decideTool(t, live("turn on background work for OMNI", "Say confirm.", "confirm")).allow).toBe(false);
  });
  it("live content arrays are read", () => {
    expect(liveMessagesForGuard([{ role: "user", content: [{ type: "text", text: "confirm" }] }])[0]!.parts![0]!.text).toBe("confirm");
  });
});


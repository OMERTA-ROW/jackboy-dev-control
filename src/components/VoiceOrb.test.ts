import { describe, it, expect } from "vitest";
import { orbMode } from "./VoiceOrb";
describe("orb state follows real session events", () => {
  it("maps each state", () => {
    expect(orbMode("listening", true, true)).toBe("listening");
    expect(orbMode("speaking", false, true)).toBe("speaking");
    expect(orbMode("processing", false, true)).toBe("thinking");
    expect(orbMode("idle", true, true)).toBe("thinking");
    expect(orbMode("idle", false, false)).toBe("muted");
    expect(orbMode("idle", false, true)).toBe("idle");
    expect(orbMode("error", false, true)).toBe("error");
    expect(orbMode("error", true, true)).toBe("thinking");
  });
});

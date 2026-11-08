import { describe, expect, it } from "vitest";
import { globalPauseReason, KILL_SWITCH_ON, KILL_SWITCH_UNREADABLE } from "./global-pause";

describe("global Kill Switch rule", () => {
  it("blocks all work when the Kill Switch is on", () => {
    expect(globalPauseReason({ paused: true }, false)).toBe(KILL_SWITCH_ON);
  });
  it("allows work only when the Kill Switch is readably off", () => {
    expect(globalPauseReason({ paused: false }, false)).toBeNull();
  });
  it("fails closed when the state cannot be read", () => {
    expect(globalPauseReason(null, false)).toBe(KILL_SWITCH_UNREADABLE);
    expect(globalPauseReason({ paused: false }, true)).toBe(KILL_SWITCH_UNREADABLE);
    expect(globalPauseReason({ paused: "no" }, false)).toBe(KILL_SWITCH_UNREADABLE);
  });
});

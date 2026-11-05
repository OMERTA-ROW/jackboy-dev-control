import { describe, expect, it } from "vitest";
import { liveReadiness } from "./activation-readiness";
const input = { checkedAt: "2026-11-05T21:31:40Z", pinsMatch: false, disabled: true, stopped: true, noActiveRun: true, gatesProtected: true };
describe("activation evidence never grants execution", () => {
  it("keeps stale workflow pins owner-gated despite passing stop controls", () => {
    expect(liveReadiness(input).map((item) => item.status)).toEqual(["OWNER ACTION", "PASS", "PASS"]);
  });
  it("fails safety evidence when stop is released, enabled or an active run exists", () => {
    for (const change of [{ stopped: false }, { disabled: false }, { noActiveRun: false }]) {
      expect(liveReadiness({ ...input, ...change })[1]?.status).toBe("BLOCKED");
    }
  });
  it("requires both protected gates independently of matching pins", () => {
    expect(liveReadiness({ ...input, pinsMatch: true, gatesProtected: false }).map((item) => item.status)).toEqual(["PASS", "PASS", "BLOCKED"]);
  });
});
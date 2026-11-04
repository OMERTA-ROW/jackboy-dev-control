import { describe, expect, it } from "vitest";
import { followTarget, isNearBottom, nextFollow, parseFeedback, speakableText, toggleFeedback } from "./chat-scroll";

const m = (scrollTop: number, scrollHeight: number, viewportHeight = 800) => ({ scrollTop, scrollHeight, viewportHeight });

describe("streaming scroll anchoring", () => {
  it("near bottom within 120px", () => {
    expect(isNearBottom(m(1080, 2000))).toBe(true);
    expect(isNearBottom(m(1000, 2000))).toBe(false);
  });
  it("streamed growth keeps following when reader was at bottom", () => {
    const s = nextFollow({ follow: true, lastTop: 1200 }, m(1200, 2400));
    expect(s.follow).toBe(true);
    expect(followTarget(s.follow, m(1200, 2400))).toBe(1600);
  });
  it("scrolling up releases follow and preserves reading position", () => {
    const s = nextFollow({ follow: true, lastTop: 1200 }, m(600, 2000));
    expect(s.follow).toBe(false);
    expect(followTarget(s.follow, m(600, 3000))).toBeNull();
  });
  it("returning to bottom re-engages follow", () => {
    expect(nextFollow({ follow: false, lastTop: 600 }, m(1190, 2000)).follow).toBe(true);
  });
  it("no redundant scroll when already pinned", () => {
    expect(followTarget(true, m(1200, 2000))).toBeNull();
  });
});

describe("message actions", () => {
  it("speak-back strips markdown and code", () => {
    expect(speakableText("**Hi** see [docs](https://x.y)\n```js\nx()\n```")).toBe("Hi see docs code block omitted.");
  });
  it("feedback toggles and clears", () => {
    const a = toggleFeedback({}, "m1", "up");
    expect(a).toEqual({ m1: "up" });
    expect(toggleFeedback(a, "m1", "down")).toEqual({ m1: "down" });
    expect(toggleFeedback(a, "m1", "up")).toEqual({});
  });
  it("feedback parse rejects junk", () => {
    expect(parseFeedback('{"a":"up","b":"evil"}')).toEqual({ a: "up" });
    expect(parseFeedback("not json")).toEqual({});
  });
});

import { composerHeight, preservedScrollTop, frameBatcher } from "./chat-scroll";
describe("composer and history helpers", () => {
  it("grows composer to a viewport-aware max then scrolls", () => {
    expect(composerHeight(60, 800)).toEqual({ height: 60, overflow: false });
    expect(composerHeight(900, 800)).toEqual({ height: 320, overflow: true });
    expect(composerHeight(900, 300)).toEqual({ height: 120, overflow: true }); // phone with keyboard open
  });
  it("keeps reading position when older history is inserted above", () => {
    expect(preservedScrollTop(200, 1000, 1600)).toBe(800);
  });
  it("batches many updates into one frame", () => {
    let cb: (() => void) | null = null; let runs = 0;
    const b = frameBatcher(() => runs++, (f) => { cb = f; return 1; }, () => { cb = null; });
    b.schedule(); b.schedule(); b.schedule();
    (cb as unknown as () => void)(); expect(runs).toBe(1);
  });
});

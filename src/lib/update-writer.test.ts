import { describe, expect, it } from "vitest";
import { canMerge, canTransition, isDue, parseProposal, parseRepo, safePath, underCap } from "./update-writer";
import { parseFeed, safeFetchUrl, tagProjects } from "./feeds";

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
  });
  it("status can never be set to merged directly", () => expect(canTransition("pr_open", "merged")).toBe(false));
  it("rejects AI output missing a build prompt", () => {
    expect(() => parseProposal(JSON.stringify({ title: "a", what_to_change: "b", why: "c" }))).toThrow();
  });
});

describe("merge gate", () => {
  it("merges only with passing checks", () => expect(canMerge("pr_open", "success", false).ok).toBe(true));
  it("blocks failed builds even if owner accepts", () => expect(canMerge("pr_open", "failure", true).ok).toBe(false));
  it("blocks pending checks", () => expect(canMerge("pr_open", "pending", true).ok).toBe(false));
  it("no checks requires explicit owner confirmation", () => {
    expect(canMerge("pr_open", "none", false).ok).toBe(false);
    expect(canMerge("pr_open", "none", true).ok).toBe(true);
  });
});

describe("code safety", () => {
  it("drops unsafe file paths from AI output", () => {
    const d = parseProposal(JSON.stringify({ title: "t", what_to_change: "w", why: "y", build_prompt: "b", files: [
      { path: "src/a.ts", content: "x" }, { path: "../etc/passwd", content: "x" }, { path: ".env", content: "x" }, { path: ".github/workflows/ci.yml", content: "x" },
    ] }));
    expect(d.files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });
  it("blocks .git paths", () => expect(safePath(".git/config")).toBe(false));
  it("parses owner/repo only", () => {
    expect(parseRepo("acme/app")).toEqual({ owner: "acme", repo: "app" });
    expect(parseRepo("https://github.com/acme/app")).toBeNull();
  });
});

describe("spending cap", () => {
  it("allows up to the cap and stops at it", () => {
    expect(underCap(99, 100)).toBe(true);
    expect(underCap(100, 100)).toBe(false);
  });
  it("cap 0 allows nothing", () => expect(underCap(0, 0)).toBe(false));
});

describe("feeds", () => {
  it("parses RSS items", () => {
    const items = parseFeed(`<rss><channel><item><title>New &amp; shiny</title><link>https://x.dev/a</link><description><![CDATA[<p>Hello</p>]]></description></item></channel></rss>`);
    expect(items[0]).toMatchObject({ title: "New & shiny", url: "https://x.dev/a", summary: "Hello" });
  });
  it("tags by source projects first, else by project name", () => {
    const ps = [{ id: "1", name: "Jackboy" }, { id: "2", name: "OMNI" }];
    expect(tagProjects(["2"], "jackboy news", ps)).toEqual(["2"]);
    expect(tagProjects([], "Big Jackboy release", ps)).toEqual(["1"]);
  });
  it("blocks private network URLs", () => {
    expect(safeFetchUrl("http://127.0.0.1/x")).toBe(false);
    expect(safeFetchUrl("http://192.168.1.2")).toBe(false);
    expect(safeFetchUrl("https://example.com/feed")).toBe(true);
  });
});

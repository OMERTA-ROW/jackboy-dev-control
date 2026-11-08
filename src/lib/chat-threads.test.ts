import { describe, expect, it } from "vitest";
import { changedMessages, cleanQuery, escapeLike, fingerprint, messageContent, messageCreatedAt, searchSnippet } from "./chat-threads";

describe("saved conversation text", () => {
  it("indexes words and attachment names, hiding credential-looking strings", () => {
    const text = messageContent([{ type: "text", text: "token ghp_abcdefghijklmnopqrstuvwxyz123456 here" }, { type: "file", filename: "iggy.mp4" }, { type: "tool-x" }]);
    expect(text).toContain("[hidden]");
    expect(text).toContain("[iggy.mp4]");
    expect(text).not.toContain("ghp_");
  });
  it("saves only new or changed messages", () => {
    const a = { id: "a", parts: [{ type: "text", text: "hi" }] };
    const b = { id: "b", parts: [{ type: "text", text: "yo" }] };
    const saved = new Map([["a", fingerprint(a)], ["b", fingerprint({ ...b, parts: [] })]]);
    expect(changedMessages([a, b], saved).map((m) => m.id)).toEqual(["b"]);
  });
  it("keeps recorded arrival time, else uses the fallback", () => {
    expect(messageCreatedAt({ createdAt: 1_788_000_000_000 }, 0)).toBe(new Date(1_788_000_000_000).toISOString());
    expect(messageCreatedAt({ createdAt: "soon" }, 1_788_000_000_000)).toBe(new Date(1_788_000_000_000).toISOString());
  });
});

describe("search", () => {
  it("needs at least two characters and trims long input", () => {
    expect(cleanQuery(" a ")).toBeNull();
    expect(cleanQuery("  omni   link ")).toBe("omni link");
    expect(cleanQuery("x".repeat(300))!.length).toBe(100);
  });
  it("matches the owner's text literally", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
  });
  it("shows a short snippet around the match", () => {
    const s = searchSnippet(`${"a ".repeat(100)}OMNI handshake ok ${"b ".repeat(100)}`, "handshake", 10);
    expect(s).toContain("handshake");
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
  });
});

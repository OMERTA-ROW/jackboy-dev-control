import { describe, expect, it } from "vitest";
import { hostAllowed, rateLimitStatus, validateQuery, RATE_LIMIT_PER_MINUTE, RATE_LIMIT_PER_DAY } from "./search-policy";

describe("search policy", () => {
  it("allows listed domains and subdomains over https only", () => {
    expect(hostAllowed("https://arxiv.org/abs/1234")).toBe(true);
    expect(hostAllowed("https://export.arxiv.org/x")).toBe(true);
    expect(hostAllowed("http://arxiv.org/abs/1234")).toBe(false);
    expect(hostAllowed("https://evilarxiv.org/")).toBe(false);
    expect(hostAllowed("https://random-blog.com/post")).toBe(false);
  });
  it("rejects empty, oversized and credential-hunting queries", () => {
    expect(validateQuery(" ").ok).toBe(false);
    expect(validateQuery("x".repeat(201)).ok).toBe(false);
    expect(validateQuery("filetype:env AWS").ok).toBe(false);
    expect(validateQuery("solid state batteries")).toEqual({ ok: true, query: "solid state batteries" });
  });
  it("enforces per-minute and per-day limits", () => {
    expect(rateLimitStatus(RATE_LIMIT_PER_MINUTE - 1, 0).allowed).toBe(true);
    expect(rateLimitStatus(RATE_LIMIT_PER_MINUTE, 0).allowed).toBe(false);
    expect(rateLimitStatus(0, RATE_LIMIT_PER_DAY).allowed).toBe(false);
  });
});

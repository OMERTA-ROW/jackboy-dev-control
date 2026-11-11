import { describe, expect, it } from "vitest";
import { oauthReturnPath } from "./oauth-return-path";

describe("oauthReturnPath", () => {
  it("keeps the consent path with its authorization id", () => {
    expect(oauthReturnPath("/.lovable/oauth/consent?authorization_id=abc")).toBe("/.lovable/oauth/consent?authorization_id=abc");
  });
  it("rejects external and malformed targets", () => {
    for (const bad of ["https://evil.example/x", "//evil.example", "/\\evil.example/", "/a\u0000b", "relative", 42, null]) {
      expect(oauthReturnPath(bad)).toBe("/");
    }
  });
});

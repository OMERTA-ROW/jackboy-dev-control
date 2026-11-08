import { describe, expect, it } from "vitest";
import { createCodeGithubHeaders } from "./code-github";

describe("CODE GitHub headers", () => {
  it("sends the scoped token as a separate bearer header", () => {
    const headers = createCodeGithubHeaders("test-token");

    expect(headers.get("authorization")).toBe("Bearer test-token");
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(headers.get("user-agent")).toBe("Jackboy");
    expect(headers.get("content-type")).toBe("application/json");
  });
});

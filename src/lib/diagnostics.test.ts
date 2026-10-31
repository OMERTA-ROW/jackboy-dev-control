import { describe, expect, it } from "vitest";
import { inspect } from "./diagnostics";

describe("inspect", () => {
  it("flags hardcoded credentials as errors", () => {
    const f = inspect(`const apiKey = "abcd1234efgh"`);
    expect(f[0]).toMatchObject({ rule: "possible-secret", severity: "error", line: 1 });
  });
  it("returns nothing for clean code", () => {
    expect(inspect("const a = 1 === 1;")).toEqual([]);
  });
});

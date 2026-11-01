import { describe, it, expect } from "vitest";
import { autoRunnable, canonical, dedupeKey, extractCode, prioritize, scanFile, scannable, validateFix } from "./code-scan";

const src = `export function f() {\n  debugger;\n  return <a href="x" target="_blank">x</a>;\n}\n`;

describe("code scan", () => {
  it("finds real line-level defects", () => {
    const d = scanFile("a.tsx", src);
    expect(d.map((x) => [x.rule, x.line])).toEqual([["debugger-statement", 2], ["blank-target-no-rel", 3]]);
  });
  it("masks secrets and marks them sensitive", () => {
    const d = scanFile("k.ts", `const k = "ghp_${"a".repeat(36)}";`);
    expect(d[0]).toMatchObject({ rule: "hardcoded-secret", risk: "sensitive", excerpt: "[secret masked]" });
  });
  it("ignores eval inside regex or strings (real false positive from diagnostics.ts)", () => {
    expect(scanFile("d.ts", `  { rule: "no-eval", re: /\\beval\\s*\\(/, message: "eval() executes arbitrary code." },`)).toEqual([]);
    expect(scanFile("e.ts", "const r = eval(x);")[0]?.rule).toBe("eval-call");
  });
  it("skips tests, builds and generated files", () => {
    expect(scannable("src/a.tsx")).toBe(true);
    expect(scannable("src/a.test.ts")).toBe(false);
    expect(scannable("dist/x.js")).toBe(false);
    expect(scannable("src/routeTree.gen.ts")).toBe(false);
  });
  it("low risk first, stable dedupe key", () => {
    const p = prioritize([{ rule: "eval-call", path: "a", line: 1, risk: "sensitive" } as never, { rule: "debugger-statement", path: "b", line: 1, risk: "low" } as never]);
    expect(p[0]!.risk).toBe("low");
    expect(dedupeKey({ rule: "r", path: "p", line: 3 })).toBe("scan:r:p:3");
  });
});

describe("fix validation", () => {
  const d = scanFile("a.tsx", src)[0]!;
  it("accepts a minimal correct fix", () => {
    expect(validateFix(d, src, src.replace("  debugger;\n", "")).ok).toBe(true);
  });
  it("rejects no-op, unrelated rewrite and new defects", () => {
    expect(validateFix(d, src, src).ok).toBe(false);
    expect(validateFix(d, src, "export const x = 1;\n").ok).toBe(false);
    expect(validateFix(d, src, src.replace("  debugger;\n", "  eval(s);\n")).ok).toBe(false);
  });
  it("extracts fenced code", () => {
    expect(extractCode("here:\n```tsx\nconst a = 1;\n```")).toBe("const a = 1;\n");
  });
  it("only low-risk validated single-file work auto-runs", () => {
    const v = validateFix(d, src, src.replace("  debugger;\n", ""));
    expect(autoRunnable({ risk: "low" }, v, 1)).toBe(true);
    expect(autoRunnable({ risk: "sensitive" }, v, 1)).toBe(false);
    expect(autoRunnable({ risk: "low" }, v, 2)).toBe(false);
  });
  it("canonical JSON is key-order independent", () => {
    expect(canonical({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
});

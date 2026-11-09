import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The published app runs on the edge runtime, which throws on `redirect: "error"`
// ("use manual and check the status code"). That one option broke every CODE GitHub check
// on the live site, so no server code may use it again.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("edge-safe fetch options", () => {
  it('no source file uses redirect: "error"', () => {
    const offenders = sourceFiles("src").filter((file) => /redirect:\s*["']error["']/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("CODE GitHub calls send a User-Agent, which GitHub requires", () => {
    for (const file of ["src/lib/code-github.ts", "src/lib/code-safety.functions.ts", "src/lib/code-runner-auth.server.ts"]) {
      expect(readFileSync(file, "utf8")).toContain('"User-Agent": "Jackboy"');
    }
  });
});

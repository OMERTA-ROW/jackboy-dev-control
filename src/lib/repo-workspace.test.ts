import { describe, expect, it } from "vitest";
import { checkPath, checkWorkBranch, parseRepo } from "./repo-workspace";

describe("repo workspace guards", () => {
  it("refuses writes outside jackboy/ branches or to the base branch", () => {
    expect(checkWorkBranch("main", "main")).toMatch(/Refused/);
    expect(checkWorkBranch("feature/x", "main")).toMatch(/Refused/);
    expect(checkWorkBranch("jackboy/fix-1", "main")).toBeNull();
  });
  it("refuses traversal and protected files", () => {
    expect(checkPath("../etc/passwd")).not.toBeNull();
    expect(checkPath("/abs.ts")).not.toBeNull();
    expect(checkPath(".env")).not.toBeNull();
    expect(checkPath("src/integrations/supabase/client.ts")).not.toBeNull();
    expect(checkPath("src/routes/index.tsx")).toBeNull();
  });
  it("parses owner/repo only", () => {
    expect(parseRepo("street-Tech666/jackboy-dev-control")).toEqual({ owner: "street-Tech666", repo: "jackboy-dev-control" });
    expect(parseRepo("https://github.com/a/b")).toBeNull();
  });
});

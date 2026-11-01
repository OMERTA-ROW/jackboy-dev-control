import { describe, expect, it } from "vitest";
import { buildJackboyManifest, missing, nextActions, type Checks } from "./agent-manifest";

const ok: Checks = { ai: true, githubRepo: { ok: true, usable: 1 }, actionsRead: false, projectsWithSite: 1, voiceServer: true, outboxTargets: 0, omniVerified: false };
const cap = (c: Checks, id: string) => buildJackboyManifest(c).capabilities.find((x) => x.id === id)!;

describe("agent manifest", () => {
  it("marks repo editing operational only with a usable private repo", () => {
    expect(cap(ok, "repo_edit").status).toBe("operational");
    expect(cap({ ...ok, githubRepo: { ok: true, usable: 0 } }, "repo_edit").status).toBe("blocked");
  });
  it("blocks scanning with no site addresses and gives a fix", () => {
    const c = cap({ ...ok, projectsWithSite: 0 }, "scan");
    expect(c.status).toBe("blocked"); expect(c.fix).toBeTruthy();
  });
  it("never reports test running or deploys as operational", () => {
    expect(cap(ok, "run_tests").status).toBe("not_built");
    expect(cap(ok, "deploy").status).toBe("not_built");
  });
  it("OMNI delegation blocked until verified", () => expect(cap(ok, "omni_delegate").status).toBe("blocked"));
  it("lists missing capabilities", () => expect(missing(buildJackboyManifest(ok)).map((c) => c.id)).toContain("ci_results"));
  it("suggests scan, fix, then the first unblock", () => expect(nextActions(buildJackboyManifest(ok))).toEqual([
    "Scan selected projects and list issues",
    "Write a fix for the top issue and open a draft pull request",
    "Unblock: Give the GitHub token 'Actions: Read-only', then press Verify on AutoConnect",
  ]));
  it("never includes secret-looking text", () => expect(JSON.stringify(buildJackboyManifest(ok))).not.toMatch(/ghp_|sk_|eyJ/));
});

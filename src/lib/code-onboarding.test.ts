import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  activationBlockReason, buildChecklist, codeTargetsWithout, detectProfile, gitBlobSha, nextCodeTargetsValue,
  PROFILE_PATHS, siteAddTarget, siteRemoveTarget, sitePhase, type ProfileFile, type SiteFacts,
} from "./code-onboarding";
import { FRESH_ONLY_ACTIONS, recentEligible } from "./step-up";
import { checkWorkflowContent } from "./guidelines";

const SHA = "a".repeat(40);
const files: ProfileFile[] = Object.values(PROFILE_PATHS).map((path, i) => ({ path, content: "x", sha: i === 0 ? SHA : String(i).repeat(40) }));
const onMain = Object.fromEntries(files.map((f) => [f.path, f.sha]));
const env = { exists: true, protected: true, readable: true };
const good = (over: Partial<SiteFacts> = {}): SiteFacts => ({
  repo: "OMERTA-ROW/hercules-driver-os", defaultBranch: "main", appCanWrite: true, profile: { kind: "web" }, expected: files,
  branchFiles: onMain, mainFiles: onMain, pr: { number: 3, url: "u", state: "merged" }, workflowWriteRefused: false,
  environments: { CODE: env, "CODE-PUBLISH": env }, dispatchCredential: "ok", runnerVariable: "ok",
  codeTargets: { present: true, parses: true, entry: { ref: "main", workflowSha: SHA } }, pinned: null,
  pinStorageReady: true, siteCount: 1, activeTask: false, ...over,
});

describe("Add project to CODE — pin and file identity", () => {
  it("computes the same blob SHA GitHub and git use", async () => {
    expect(await gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    for (const f of ["src/lib/code-profiles/web.code.yml", "src/lib/code-profiles/go.code.yml"]) {
      const want = execFileSync("git", ["hash-object", "--no-filters", f]).toString().trim();
      expect(await gitBlobSha(readFileSync(f, "utf8"))).toBe(want);
    }
  });

  it("approved workflow versions keep both GitHub approval environments, draft PRs only, and pass the workflow guard", () => {
    for (const f of ["src/lib/code-profiles/web.code.yml", "src/lib/code-profiles/go.code.yml"]) {
      const y = readFileSync(f, "utf8");
      expect(y).toContain("environment: CODE\n");
      expect(y).toContain("environment: CODE-PUBLISH");
      expect(y).toContain("gh pr create");
      expect(y).toContain("--draft");
      expect(y).not.toMatch(/gh pr merge|pull_request_target|secrets\./);
      expect(checkWorkflowContent(y)).toBeNull();
    }
  });
});

describe("workflow version choice", () => {
  it("picks Go for go.mod and web for a locked package with a build script", () => {
    expect(detectProfile(["go.mod"], null)).toEqual({ kind: "go" });
    expect(detectProfile(["package.json", "bun.lockb"], { build: "vite build" })).toEqual({ kind: "web" });
    expect(detectProfile(["package.json", "package-lock.json"], { build: "vite build" })).toEqual({ kind: "web" });
  });
  it("blocks with the fix when no version fits", () => {
    expect(detectProfile(["package.json"], { build: "x" }).kind).toBeNull();
    expect(detectProfile(["package.json", "bun.lock"], {}).kind).toBeNull();
    expect(detectProfile(["README.md"], null).kind).toBeNull();
  });
  it("names Go folders when go.mod lives only in subfolders, and never guesses a profile for them", () => {
    const r = detectProfile(["Dockerfile", "README.md"], null, ["cli", "inbox"]);
    expect(r.kind).toBeNull();
    expect(r.kind === null && r.reason).toContain("cli/, inbox/");
    // A root go.mod still wins; subfolders are irrelevant then.
    expect(detectProfile(["go.mod"], null, ["cli"])).toEqual({ kind: "go" });
  });
});

describe("activation gates", () => {
  it("offers the passkey only when every gate passes", () => {
    const items = buildChecklist(good());
    expect(activationBlockReason(items)).toBeNull();
    expect(sitePhase(items)).toBe("ready");
  });
  it("a workflow on main that differs from the approved SHA blocks activation", () => {
    expect(activationBlockReason(buildChecklist(good({ mainFiles: { ...onMain, [PROFILE_PATHS.workflow]: "b".repeat(40) } })))).toMatch(/Onboarding PR merged/);
  });
  it("changed helper scripts on main also block activation", () => {
    expect(activationBlockReason(buildChecklist(good({ mainFiles: { ...onMain, [PROFILE_PATHS.validation]: "c".repeat(40) } })))).toMatch(/Onboarding PR merged/);
  });
  it("a missing or unprotected GitHub approval environment blocks activation", () => {
    expect(activationBlockReason(buildChecklist(good({ environments: { CODE: { exists: false, protected: false, readable: true }, "CODE-PUBLISH": env } })))).toMatch(/environment CODE /);
    expect(activationBlockReason(buildChecklist(good({ environments: { CODE: env, "CODE-PUBLISH": { exists: true, protected: false, readable: true } } })))).toMatch(/CODE-PUBLISH/);
    expect(activationBlockReason(buildChecklist(good({ environments: null })))).toMatch(/environment CODE /);
  });
  it("CODE_TARGETS must list this site with the same SHA", () => {
    expect(activationBlockReason(buildChecklist(good({ codeTargets: { present: true, parses: true, entry: null } })))).toMatch(/CODE_TARGETS/);
    expect(activationBlockReason(buildChecklist(good({ codeTargets: { present: true, parses: true, entry: { ref: "main", workflowSha: "d".repeat(40) } } })))).toMatch(/CODE_TARGETS/);
  });
  it("blocks until the reviewed database update is applied, while a task runs, or at 10 sites", () => {
    expect(activationBlockReason(buildChecklist(good({ pinStorageReady: false })))).toMatch(/Database/);
    expect(activationBlockReason(buildChecklist(good({ activeTask: true })))).toMatch(/No CODE task running/);
    expect(activationBlockReason(buildChecklist(good({ siteCount: 10 })))).toMatch(/10 sites/);
  });
  it("the run-starting credential must reach the repo", () => {
    expect(activationBlockReason(buildChecklist(good({ dispatchCredential: "no_access" })))).toMatch(/Run-starting credential/);
  });
  it("shows active once pinned", () => {
    expect(sitePhase(buildChecklist(good({ pinned: { ref: "main", workflowSha: SHA } })))).toBe("active");
  });
});

describe("allow-list values and passkey binding", () => {
  it("the CODE_TARGETS value keeps every existing site and adds this one on main", () => {
    const cur = { "OMERTA-ROW/jackboy-dev-control": { ref: "main", workflowSha: "e".repeat(40) } };
    expect(JSON.parse(nextCodeTargetsValue(cur, "OMERTA-ROW/hercules-driver-os", SHA))).toEqual({ ...cur, "OMERTA-ROW/hercules-driver-os": { ref: "main", workflowSha: SHA } });
    expect(JSON.parse(codeTargetsWithout({ ...cur, "o/x": { ref: "main", workflowSha: SHA } }, "o/x"))).toEqual(cur);
  });
  it("each passkey grant is bound to one site and, when adding, one exact workflow SHA", () => {
    expect(siteAddTarget("o/x", SHA)).not.toBe(siteAddTarget("o/x", "b".repeat(40)));
    expect(siteAddTarget("o/x", SHA)).not.toBe(siteAddTarget("o/y", SHA));
    expect(siteRemoveTarget("o/x")).not.toBe(siteAddTarget("o/x", SHA));
  });
  it("pinning a site always needs a new passkey check, never a recent one", () => {
    expect(FRESH_ONLY_ACTIONS).toContain("code_site_pin");
    expect(recentEligible("code_site_pin", siteAddTarget("o/x", SHA))).toBe(false);
  });
});

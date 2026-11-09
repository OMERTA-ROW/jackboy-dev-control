import { describe, expect, it } from "vitest";
import { deploymentVerdict, parseBuildInfo } from "./build-info";

const A = "4ce3b4373a32d355618dfcd1ec9a75992d1f10ed";
const B = "d93ef3f0000000000000000000000000000000aa";
const T1 = "1111111111111111111111111111111111111111";
const T2 = "2222222222222222222222222222222222222222";
const clean = (commit: string | null, tree: string | null = T1) =>
  parseBuildInfo({ commit, tree, dirty: false, builtAt: "2026-11-08T06:00:00Z" });

describe("parseBuildInfo", () => {
  it("accepts only full 40-character commit ids", () => {
    expect(parseBuildInfo({ commit: "4ce3b43", tree: "x", dirty: "no" })).toEqual({
      commit: null,
      tree: null,
      dirty: null,
      builtAt: null,
    });
    expect(parseBuildInfo(null).commit).toBeNull();
    expect(clean(A).commit).toBe(A);
  });
});

describe("deploymentVerdict", () => {
  it("passes when the live build is GitHub main's commit", () => {
    expect(deploymentVerdict(clean(A), { commit: A, tree: T1 }).status).toBe("PASS");
  });
  it("passes when a different commit has identical files to main", () => {
    expect(deploymentVerdict(clean(B, T1), { commit: A, tree: T1 }).status).toBe("PASS");
  });
  it("blocks when the live files differ from main", () => {
    const v = deploymentVerdict(clean(B, T2), { commit: A, tree: T1 });
    expect(v.status).toBe("BLOCKED");
    expect(v.reason).toContain("d93ef3f");
    expect(v.reason).toContain("4ce3b43");
  });
  it("blocks a build with uncommitted changes even on main's commit", () => {
    const dirty = parseBuildInfo({ commit: A, tree: T1, dirty: true });
    expect(deploymentVerdict(dirty, { commit: A, tree: T1 }).status).toBe("BLOCKED");
  });
  it("blocks when the build has no git details or the dirty state is unknown", () => {
    expect(deploymentVerdict(clean(null), { commit: A, tree: T1 }).status).toBe("BLOCKED");
    expect(deploymentVerdict(parseBuildInfo({ commit: A }), { commit: A, tree: T1 }).status).toBe(
      "BLOCKED",
    );
  });
  it("blocks when GitHub main can't be read", () => {
    expect(deploymentVerdict(clean(A), null).status).toBe("BLOCKED");
  });
});

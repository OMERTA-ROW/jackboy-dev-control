import { describe, it, expect } from "vitest";
import { explainFailure, tokenKind, pickRepos } from "./github-token";
import { passkeyOrigin } from "./passkey-origin";

describe("github token reasons", () => {
  it("org approval pending points to org requests page", () => {
    const r = explainFailure(403, "Pending approval by organization", "OMERTA-ROW/Omni", "fine-grained", "write");
    expect(r.fixUrl).toContain("OMERTA-ROW/settings/personal-access-token-requests");
  });
  it("missing write says Contents read and write", () => {
    expect(explainFailure(403, "Resource not accessible by personal access token", "OMERTA-ROW/Omni", "fine-grained", "write").reason).toContain("Contents: Read and write");
  });
  it("401 is invalid token", () => { expect(explainFailure(401, "Bad credentials", "", "classic", "read").reason).toContain("invalid"); });
  it("detects token kind", () => { expect(tokenKind("github_pat_x")).toBe("fine-grained"); expect(tokenKind("ghp_x")).toBe("classic"); });
  it("picks keyword repos", () => { expect(pickRepos(["a/Omni"], ["me/honeycomb-vault", "me/other"], ["vault"])).toEqual(["a/Omni", "me/honeycomb-vault"]); });
});

describe("passkey origins", () => {
  it("published site", () => expect(passkeyOrigin("https://jackboy-dev-control.lovable.app").rpID).toBe("jackboy-dev-control.lovable.app"));
  it("preview", () => expect(passkeyOrigin("https://id-preview--72823346-c174-4e90-9e17-671e197837c5.lovable.app").rpID).toContain("id-preview"));
  it("rejects others", () => expect(() => passkeyOrigin("https://evil.lovable.app")).toThrow());
});

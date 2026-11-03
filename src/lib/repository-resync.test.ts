import { describe, expect, it } from "vitest";
import { canonicalRepo, candidates, listTokenRepositories, reviewReferences } from "./repository-resync";
describe("repository resync approval rules", () => {
  it("proposes the moved Terminal repo by name without editing the saved reference", () => {
    const refs = [{ table: "owner_projects", id: "1", field: "github_repo", value: "street-Tech666/Honeycomb-terminal", mutable: true }];
    const rows = reviewReferences(refs, ["OMERTA-ROW/honeycomb-terminal-companion"]);
    expect(rows[0]?.candidates[0]).toBe("OMERTA-ROW/honeycomb-terminal-companion");
    expect(refs[0]?.value).toBe("street-Tech666/Honeycomb-terminal");
  });
  it("also matches the actual misspelled saved Terminal name", () => {
    expect(candidates("street-Tech666/Honeyconb-Terminal-", ["OMERTA-ROW/honeycomb-terminal-companion"])).toEqual(["OMERTA-ROW/honeycomb-terminal-companion"]);
  });
  it("does not infer token access from public visibility or org ownership", () => {
    expect(reviewReferences([{ table: "owner_projects", id: "1", field: "github_repo", value: "OMERTA-ROW/Omni", mutable: true }], [])[0]?.status).toBe("missing");
  });
  it("normalizes URLs but rejects non-GitHub hosts", () => {
    expect(canonicalRepo("https://github.com/OMERTA-ROW/Omni.git")).toBe("OMERTA-ROW/Omni");
    expect(canonicalRepo("https://evil.example/OMERTA-ROW/Omni")).toBeNull();
  });
  it("lists repositories beyond the first page", async () => {
    const paths: string[] = [];
    const repos = await listTokenRepositories(async path => {
      paths.push(path);
      return new Response(JSON.stringify([{ full_name: paths.length === 1 ? "a/one" : "OMERTA-ROW/Omni" }]), { headers: paths.length === 1 ? { link: '<next>; rel="next"' } : {} });
    });
    expect(paths).toHaveLength(2);
    expect(repos).toContain("OMERTA-ROW/Omni");
  });
  it("refuses partial results when a later page fails", async () => {
    let n = 0;
    await expect(listTokenRepositories(async () => ++n === 1 ? new Response('[{"full_name":"a/one"}]', { headers: { link: '<next>; rel="next"' } }) : new Response('{"message":"Bad credentials"}', { status: 401 }))).rejects.toThrow("GitHub 401: Bad credentials");
  });
});
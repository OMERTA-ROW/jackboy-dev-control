import { describe, expect, it } from "vitest";
import { buildRepositoryReview, closestRepo, projectRepoMatch, needsRepositoryCheck, RESYNC_INTERVAL_MS, tokenOwnerWarning } from "./repository-resync";
const ref = (value: string, mutable = true) => ({ table: "owner_projects", id: "p", field: "github_repo", value, mutable });
describe("repository resync rules", () => {
  it("proposes missing links by project name from token inventory only", () => {
    expect(projectRepoMatch("Honeycomb Vault", null, [{ full_name: "OMERTA-ROW/honeycomb-vault" }])).toBe("OMERTA-ROW/honeycomb-vault");
    expect(projectRepoMatch("Jax Data Concierge", null, [{ full_name: "OMERTA-ROW/Jax" }])).toBe("OMERTA-ROW/Jax");
    expect(projectRepoMatch("Unknown", null, [])).toBeNull();
  });
  it("prefers a unique Lovable project link and refuses ambiguous links", () => {
    const id = "72823346-c174-4e90-9e17-671e197837c5";
    const candidate = { full_name: "OMERTA-ROW/renamed", homepage: `https://lovable.dev/projects/${id}` };
    expect(projectRepoMatch("Old name", `https://lovable.dev/projects/${id}`, [candidate])).toBe(candidate.full_name);
    expect(projectRepoMatch("Old name", id, [candidate, { ...candidate, full_name: "OMERTA-ROW/duplicate" }])).toBeNull();
  });
  it("rechecks every 15 minutes", () => { expect(RESYNC_INTERVAL_MS).toBe(900000); expect(needsRepositoryCheck(new Date(0).toISOString(), false, 900000)).toBe(true); expect(needsRepositoryCheck(new Date(0).toISOString(), false, 899999)).toBe(false); });
  it("rechecks invalidated access with bounded failure backoff", () => { expect(needsRepositoryCheck(new Date(0).toISOString(), true, 60000)).toBe(true); expect(needsRepositoryCheck(new Date(0).toISOString(), true, 59999)).toBe(false); });
  it("proposes Terminal migration to the accessible companion", () => { expect(closestRepo("street-Tech666/Honeycomb-terminal", ["OMERTA-ROW/honeycomb-terminal-companion"])).toBe("OMERTA-ROW/honeycomb-terminal-companion"); });
  it("matches the owner's misspelled Honeyconb-Terminal reference", () => { expect(closestRepo("street-Tech666/Honeyconb-Terminal-", ["OMERTA-ROW/honeycomb-terminal-companion"])).toBe("OMERTA-ROW/honeycomb-terminal-companion"); });
  it("marks a 404 for owner-approved unlinking, preserving historical refs", () => { const [row] = buildRepositoryReview([ref("OMERTA-ROW/Honeycomb"), ref("OMERTA-ROW/Honeycomb", false)], [], { "OMERTA-ROW/Honeycomb": { status: 404 } }); expect(row).toMatchObject({ group: "deleted", proposed: null, canApply: true, mutable: 1, historical: 1 }); });
  it("does not permit removals on 403 or incomplete checks", () => { const [row] = buildRepositoryReview([ref("OMERTA-ROW/Omni")], [], { "OMERTA-ROW/Omni": { status: 403 } }); expect(row?.canApply).toBe(false); });
  it("requires both accessible listing and existence for Linked OK", () => { expect(buildRepositoryReview([ref("OMERTA-ROW/Omni")], ["OMERTA-ROW/Omni"], { "OMERTA-ROW/Omni": { status: 404 } })[0]?.group).not.toBe("linked"); });
  it("keeps case-only repo differences linked", () => { expect(buildRepositoryReview([ref("OMERTA-ROW/Jax")], ["OMERTA-ROW/jax"], { "OMERTA-ROW/Jax": { status: 200 } })[0]?.group).toBe("linked"); });
  it("never proposes changes to immutable history", () => { expect(buildRepositoryReview([ref("OMERTA-ROW/missing", false)], [], { "OMERTA-ROW/missing": { status: 404 } })[0]?.canApply).toBe(false); });
  it("warns on personal owner with organization references", () => { expect(tokenOwnerWarning("street-Tech666", ["OMERTA-ROW/Omni"])).not.toBeNull(); expect(tokenOwnerWarning("OMERTA-ROW", ["OMERTA-ROW/Omni"])).toBeNull(); });
});
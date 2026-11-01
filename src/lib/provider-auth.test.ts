import { describe, expect, it } from "vitest";
import { parseRepo, providerAuthFor } from "./provider-auth";

describe("provider auth links", () => {
  it("targets the OMERTA-ROW org with write scopes for code access", () => {
    const a = providerAuthFor("github_repo", "OMERTA-ROW/Omni")!;
    const u = new URL(a.links[0].url);
    expect(u.hostname).toBe("github.com");
    expect(u.searchParams.get("target_name")).toBe("OMERTA-ROW");
    expect(u.searchParams.get("contents")).toBe("write");
    expect(u.searchParams.get("pull_requests")).toBe("write");
    expect(a.permission).toContain("OMERTA-ROW/Omni");
    expect(a.links.some((l) => l.url.endsWith("/organizations/OMERTA-ROW/settings/personal-access-token-requests"))).toBe(true);
  });
  it("asks only for Actions read for check results", () => {
    const u = new URL(providerAuthFor("github_actions_read", "OMERTA-ROW/Omni")!.links[0].url);
    expect(u.searchParams.get("actions")).toBe("read");
    expect(u.searchParams.get("contents")).toBeNull();
  });
  it("has no link for unsupported capabilities and rejects bad repo names", () => {
    expect(providerAuthFor("deploy_api", "a/b")).toBeNull();
    expect(parseRepo("evil.com/x?y")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { appRegistrationUrl, installUrl, missingPermissions, signState, verifyState } from "./github-app";

describe("github app rules", () => {
  it("asks only for Contents/PR write and Actions/Metadata read", () => {
    const u = new URL(appRegistrationUrl("OMERTA-ROW", "https://x.app"));
    expect(u.origin + u.pathname).toBe("https://github.com/organizations/OMERTA-ROW/settings/apps/new");
    expect(u.searchParams.get("contents")).toBe("write");
    expect(u.searchParams.get("pull_requests")).toBe("write");
    expect(u.searchParams.get("actions")).toBe("read");
    expect(u.searchParams.get("administration")).toBeNull();
    expect(u.searchParams.get("public")).toBe("false");
  });
  it("reports exactly the missing permissions", () => {
    expect(missingPermissions({ metadata: "read", contents: "read", pull_requests: "write" })).toEqual(["Contents: Read & write", "Actions: Read-only"]);
    expect(missingPermissions({ metadata: "read", contents: "write", pull_requests: "write", actions: "write" })).toEqual([]);
  });
  it("rejects tampered, foreign-secret and expired install state", async () => {
    const t = await signState({ u: "owner", p: "proj", exp: Date.now() + 60_000 }, "s1");
    expect((await verifyState(t, "s1"))?.u).toBe("owner");
    expect(await verifyState(t, "s2")).toBeNull();
    expect(await verifyState(t.replace(/^./, "A"), "s1")).toBeNull();
    const old = await signState({ u: "owner", p: null, exp: Date.now() - 1 }, "s1");
    expect(await verifyState(old, "s1")).toBeNull();
  });
  it("refuses invalid slugs in install links", () => {
    expect(() => installUrl("evil/../x", "s")).toThrow();
    expect(installUrl("jackboy-omerta-row", "a.b")).toBe("https://github.com/apps/jackboy-omerta-row/installations/new?state=a.b");
  });
});

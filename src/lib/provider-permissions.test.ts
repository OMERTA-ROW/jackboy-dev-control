import { describe, expect, it } from "vitest";
import {
  isGitHubPermission,
  permissionAtLeast,
  permissionIncrease,
  permissionLevel,
} from "./provider-permissions";

describe("provider permission requests", () => {
  it("only accepts provider-catalogued permissions", () => {
    expect(isGitHubPermission("workflows")).toBe(true);
    expect(isGitHubPermission("delete_repository")).toBe(false);
  });

  it("allows only privilege increases", () => {
    expect(permissionIncrease("read", "write")).toBe(true);
    expect(permissionIncrease("write", "write")).toBe(false);
    expect(permissionIncrease("none", "read")).toBe(true);
    expect(permissionAtLeast("write", "read")).toBe(true);
    expect(permissionAtLeast("read", "write")).toBe(false);
  });

  it("normalizes unknown provider access without granting it", () => {
    expect(permissionLevel("admin")).toBe("none");
    expect(permissionLevel("read")).toBe("read");
  });
});

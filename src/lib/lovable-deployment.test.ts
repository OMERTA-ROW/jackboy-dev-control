import { describe, expect, it } from "vitest";
import {
  buildVerification,
  parseLovableProjectId,
  physicalControlMayBeEnabled,
  PHYSICAL_CONTROL_STATUS,
} from "./lovable-deployment";

describe("Lovable deployment controls", () => {
  it("accepts only canonical Lovable project IDs and project URLs", () => {
    expect(parseLovableProjectId("72823346-c174-4e90-9e17-671e197837c5")).toBe(
      "72823346-c174-4e90-9e17-671e197837c5",
    );
    expect(
      parseLovableProjectId("https://lovable.dev/projects/72823346-c174-4e90-9e17-671e197837c5"),
    ).toBe("72823346-c174-4e90-9e17-671e197837c5");
    expect(
      parseLovableProjectId("https://evil.example/projects/72823346-c174-4e90-9e17-671e197837c5"),
    ).toBeNull();
    expect(parseLovableProjectId("arbitrary-value")).toBeNull();
  });

  it("requires successful GitHub Actions for the exact full commit", () => {
    const sha = "a".repeat(40);
    const run = {
      name: "CI",
      status: "completed",
      conclusion: "success",
      headSha: sha,
      url: "https://github.com/acme/app/actions/runs/1",
    };
    expect(buildVerification({ workflowsConfigured: 1, runs: [run] }, sha).verified).toBe(true);
    expect(
      buildVerification({ workflowsConfigured: 1, runs: [run] }, "b".repeat(40)).verified,
    ).toBe(false);
    expect(
      buildVerification({ workflowsConfigured: 1, runs: [{ ...run, conclusion: "failure" }] }, sha)
        .verified,
    ).toBe(false);
    expect(buildVerification({ workflowsConfigured: 0, runs: [] }, sha).verified).toBe(false);
  });

  it("keeps physical control operations unavailable even when prerequisites appear ready", () => {
    expect(PHYSICAL_CONTROL_STATUS).toMatchObject({
      enabled: false,
      providerConnected: false,
      operationsAvailable: false,
    });
    expect(
      physicalControlMayBeEnabled({
        ownershipVerified: true,
        providerAuthenticationSupported: true,
        explicitAuthorization: true,
      }),
    ).toBe(true);
    expect(
      physicalControlMayBeEnabled({
        ownershipVerified: true,
        providerAuthenticationSupported: false,
        explicitAuthorization: true,
      }),
    ).toBe(false);
  });
});

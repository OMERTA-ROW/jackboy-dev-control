import { describe, expect, it } from "vitest";
import { projectSlotFree, usageSpike } from "./foundry";
import { deadReason, pickDeploymentUrl, publishedLovableUrl } from "./project-resync";

describe("hard limits", () => {
  it("allows only one active task per project", () => { expect(projectSlotFree(0)).toBe(true); expect(projectSlotFree(1)).toBe(false); });
  it("pauses when hourly usage passes the limit", () => { expect(usageSpike(12, 12)).toBeNull(); expect(usageSpike(13, 12)).toMatch(/usage spike/); });
});
describe("site detection and dead projects", () => {
  it("accepts only published lovable.app addresses", () => {
    expect(publishedLovableUrl("https://omni.lovable.app/x")).toBe("https://omni.lovable.app");
    expect(publishedLovableUrl("https://lovable.dev/projects/abc")).toBeNull();
    expect(publishedLovableUrl("https://id-preview--abc.lovable.app")).toBeNull();
  });
  it("prefers successful production deployments and ignores previews", () => {
    expect(pickDeploymentUrl([{ environment: "Preview", state: "success", environment_url: "https://p.vercel.app" }, { environment: "Production", state: "success", environment_url: "https://omni.vercel.app/" }])).toBe("https://omni.vercel.app");
    expect(pickDeploymentUrl([{ environment: "Production", state: "failure", environment_url: "https://x.vercel.app" }])).toBeNull();
  });
  it("flags gone, archived and stale repos only", () => {
    const now = Date.parse("2026-11-03");
    expect(deadReason({ state: "gone" }, now)).toMatch(/not found/);
    expect(deadReason({ state: "ok", archived: true }, now)).toMatch(/archived/);
    expect(deadReason({ state: "ok", pushedAt: "2025-01-01T00:00:00Z" }, now)).toMatch(/No code pushed/);
    expect(deadReason({ state: "ok", pushedAt: "2026-10-01T00:00:00Z" }, now)).toBeNull();
  });
});

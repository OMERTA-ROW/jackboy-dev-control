import { describe, expect, it } from "vitest";
import { availableInventory, latestScans, lovableUrl, projectStatus, searchByName } from "./project-hub";

const p = { id: "1", name: "Shop", site_url: "https://shop.example", lovable_url: null, github_repo: null };
const scan = (findings: unknown[], extra = {}) => ({ project_id: "1", status: "done", findings, created_at: "2026-11-01T00:00:00Z", error: null, ...extra });

describe("project status", () => {
  it("stale repo never shows active even after a clean scan", () => expect(projectStatus({ ...p, repo_sync_status: "deleted" }, scan([]))).toEqual({ label: "Repo gone", tone: "error" }));
  it("needs a site address before anything else", () => expect(projectStatus({ ...p, site_url: null }, undefined).label).toBe("Needs site address"));
  it("is never healthy without a scan", () => expect(projectStatus(p, undefined).label).toBe("Not scanned yet"));
  it("shows a failed scan as an error", () => expect(projectStatus(p, scan([], { status: "failed", error: "timeout" })).tone).toBe("error"));
  it("counts findings", () => expect(projectStatus(p, scan([{}, {}])).label).toBe("2 issues found"));
  it("is ok only with a finished clean scan", () => expect(projectStatus(p, scan([])).tone).toBe("ok"));
});

describe("inventory picker", () => {
  it("builds Lovable links only from valid IDs", () => {
    expect(lovableUrl("abc123-def")).toBe("https://lovable.dev/projects/abc123-def");
    expect(lovableUrl("../evil")).toBeNull();
  });
  it("hides already-connected and invalid entries", () => {
    const items = [
      { id: "a", name: "A", lovable_project_ref: "aaaaaa11" },
      { id: "b", name: "B", lovable_project_ref: "bbbbbb22" },
      { id: "c", name: "C", lovable_project_ref: null },
    ];
    const connected = [{ ...p, lovable_url: "https://lovable.dev/projects/aaaaaa11" }];
    expect(availableInventory(items, connected).map((i) => i.id)).toEqual(["b"]);
  });
  it("searches case-insensitively", () => expect(searchByName([{ name: "Jackboy" }, { name: "OMNI" }], "omn")).toEqual([{ name: "OMNI" }]));
  it("keeps the newest scan per project", () => {
    const m = latestScans([scan([], { created_at: "2026-10-01" }), scan([{}], { created_at: "2026-11-01" })]);
    expect(m.get("1")?.created_at).toBe("2026-11-01");
  });
});

import { cardConnection, normalizeSiteInput } from "./project-hub";
describe("project card site address", () => {
  it("normalizes public https addresses and rejects unsafe ones", () => {
    expect(normalizeSiteInput("example.com")).toBe("https://example.com");
    expect(normalizeSiteInput("https://app.example.com/")).toBe("https://app.example.com");
    expect(normalizeSiteInput("http://example.com")).toBeNull();
    expect(normalizeSiteInput("localhost:3000")).toBeNull();
    expect(normalizeSiteInput("https://192.168.1.4")).toBeNull();
    expect(normalizeSiteInput("not a url")).toBeNull();
    expect(normalizeSiteInput("")).toBeNull();
  });
});
describe("project card connection status", () => {
  const ok = { repo: "o/r", checkedAt: "2026-11-03T00:00:00Z", exists: true, read: "verified", prWrite: "verified" };
  it("never says Connected without verified backend evidence", () => {
    expect(cardConnection({ github_repo: null }, undefined).label).toBe("Not connected");
    expect(cardConnection({ github_repo: "o/r" }, undefined).label).toBe("Not verified");
    expect(cardConnection({ github_repo: "o/r" }, { ...ok, repo: "o/other" }).label).toBe("Not verified");
    expect(cardConnection({ github_repo: "o/r" }, { ...ok, read: "unknown" }).label).toBe("Access not verified");
    expect(cardConnection({ github_repo: "o/r" }, { ...ok, prWrite: "denied" }).label).toBe("Connected (read only)");
    expect(cardConnection({ github_repo: "o/r" }, { ...ok, exists: false }).label).toBe("Repo not visible");
    expect(cardConnection({ github_repo: "o/r", repo_sync_status: "deleted" }, ok).label).toBe("Repo not found");
    expect(cardConnection({ github_repo: "O/R" }, ok).label).toBe("Connected");
  });
});

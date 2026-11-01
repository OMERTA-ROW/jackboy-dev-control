import { describe, expect, it } from "vitest";
import { isExcepted, nextStage, priorityScore, ringsOpen, triage, type CatalogEntry } from "./patch-catalog";

const now = new Date("2026-11-01T00:00:00Z");
const e: CatalogEntry = { id: "a", source: "github_release", product: "app", version: "1.2.0", severity: "high", cvss: 8, exploited: false, publishedAt: "2026-11-01T00:00:00Z", signed: true, licenseOk: true };

describe("patch catalog triage", () => {
  it("scores unsigned entries 0", () => expect(priorityScore({ ...e, signed: false }, 5, now)).toBe(0));
  it("scores license-blocked entries 0", () => expect(priorityScore({ ...e, licenseOk: false }, 5, now)).toBe(0));
  it("scores entries with no exposed endpoints 0", () => expect(priorityScore(e, 0, now)).toBe(0));
  it("ranks known-exploited above unexploited", () => expect(priorityScore({ ...e, exploited: true }, 1, now)).toBeGreaterThan(priorityScore(e, 1, now)));
  it("caps at 100", () => expect(priorityScore({ ...e, cvss: 10, exploited: true, publishedAt: "2026-01-01T00:00:00Z" }, 999, now)).toBe(100));
  it("dedupes by id keeping newest and sorts", () => {
    const r = triage([e, { ...e, version: "1.3.0", publishedAt: "2026-11-01T01:00:00Z" }, { ...e, id: "b", severity: "low", cvss: null }], { app: 2 }, now);
    expect(r.map((x) => x.entry.id)).toEqual(["a", "b"]);
    expect(r[0]!.entry.version).toBe("1.3.0");
  });
});

describe("rings, exceptions, loop", () => {
  const appr = new Date("2026-10-30T00:00:00Z"); // 2 days
  it("opens only canary when canary unhealthy", () => expect(ringsOpen(e, new Date("2026-10-01"), now, false)).toEqual(["canary"]));
  it("waits 3 days for early ring", () => expect(ringsOpen(e, appr, now, true)).toEqual(["canary"]));
  it("exploited critical shortens deferral", () => expect(ringsOpen({ ...e, severity: "critical", exploited: true }, appr, now, true)).toEqual(["canary", "early"]));
  it("honors active exception", () => expect(isExcepted(e, "g", [{ group: "g", product: "app", expiresAt: "2026-12-01", reason: "x" }], now)).not.toBeNull());
  it("ignores expired exception", () => expect(isExcepted(e, "g", [{ group: "g", product: "app", expiresAt: "2026-10-01", reason: "x" }], now)).toBeNull());
  it("rolls back on failed verify", () => expect(nextStage("verify", true)).toBe("rollback"));
  it("logs failed checks", () => expect(nextStage("check", true)).toBe("log"));
  it("advances test -> approve", () => expect(nextStage("test", false)).toBe("approve"));
});

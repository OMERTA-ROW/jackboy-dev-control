import { describe, it, expect } from "vitest";
import { connectionState, suggestRepo } from "./project-connect";

const repos = [
  { repo: "street-Tech666/honeycomb-terminal-companion", usable: true, visibility: "private", org: null },
  { repo: "street-Tech666/Honeycomb-Vault", usable: true, visibility: "private", org: null },
  { repo: "street-Tech666/nanodrift", usable: true, visibility: "private", org: null },
  { repo: "OMERTA-ROW/Omni", usable: true, visibility: "public", org: "OMERTA-ROW" },
  { repo: "street-Tech666/locked", usable: false, visibility: "private", org: null },
];
describe("project → repo mapping", () => {
  it("matches real names", () => {
    expect(suggestRepo("Honeycomb Terminal Companion", repos)?.repo).toBe("street-Tech666/honeycomb-terminal-companion");
    expect(suggestRepo("Honeycomb Vault", repos)?.repo).toBe("street-Tech666/Honeycomb-Vault");
    expect(suggestRepo("NanoDrift Platform", repos)?.repo).toBe("street-Tech666/nanodrift");
    expect(suggestRepo("OMNI internal build", repos)?.repo).toBe("OMERTA-ROW/Omni");
  });
  it("suggests nothing when there is no clear match", () => expect(suggestRepo("Anomaly Legacy", repos)).toBeNull());
  it("never suggests a repo without write access", () => expect(suggestRepo("Locked", repos)).toBeNull());
  it("no repo is not connected; a public 200 is irrelevant", () => expect(connectionState(null, null).state).toBe("not_connected"));
  it("connected only after verification", () => {
    expect(connectionState("a/b", { status: "needs_approval", last_error: null }).state).toBe("needs_approval");
    expect(connectionState("a/b", { status: "error", last_error: "403" }).state).toBe("blocked");
    expect(connectionState("a/b", { status: "connected", last_error: null }).state).toBe("connected");
  });
});

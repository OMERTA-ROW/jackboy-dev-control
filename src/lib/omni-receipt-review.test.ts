import { describe, expect, it } from "vitest";
import { evaluateHandoff, linkExpiresAt, receiptFailureEntry, type HandoffFacts } from "./omni-handoff-auth";

const NOW = Date.parse("2026-11-11T17:45:00Z");
const owner = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const facts = (verifiedAt: string): HandoffFacts => ({
  isOwner: true, actorId: owner, killSwitchOn: false,
  link: { verified: true, verifiedAt, configMatches: true },
  project: { id: project, ownerId: owner, enrolled: true, repoUrl: "https://github.com/OMERTA-ROW/jackboy-dev-control" },
  job: { projectId: project, kind: "code", status: "queued", sentAt: null, codeRequestId: null, repo: "OMERTA-ROW/jackboy-dev-control", instructions: "Do the build." },
  authorization: { projectId: project, ownerId: owner, kinds: ["code", "test"], repo: "OMERTA-ROW/jackboy-dev-control", expiresAt: "2026-11-18T17:38:00Z", revokedAt: null },
});
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("OMNI exact-job approval link window", () => {
  it("is ready to approve 4:59 after the link check", () => {
    expect(evaluateHandoff(facts(ago(299_000)), "issue", NOW)).toEqual({ allowed: true, blockers: [] });
  });
  it("is blocked only by link_stale 5:01 after the link check", () => {
    expect(evaluateHandoff(facts(ago(301_000)), "issue", NOW).blockers.map((b) => b.code)).toEqual(["link_stale"]);
  });
  it("link window ends exactly 5 minutes after the check", () => {
    expect(linkExpiresAt("2026-11-11T17:37:50.639Z")).toBe("2026-11-11T17:42:50.639Z");
    expect(linkExpiresAt(null)).toBeNull();
  });
});

describe("refused review/approval log entry", () => {
  it("records the stage, job and reason as a blocked approval", () => {
    const e = receiptFailureEntry("approve", owner, "8a06c639-51af-4d89-a359-4948433913d4", new Error("OMNI's live link is not verified right now."));
    expect(e.action).toBe("omni.receipt.approve_failed");
    expect(e.status).toBe("blocked");
    expect(e.detail).toEqual({ jobId: "8a06c639-51af-4d89-a359-4948433913d4", stage: "approve", reason: "OMNI's live link is not verified right now." });
    expect(receiptFailureEntry("preview", owner, "j", new Error("x")).action).toBe("omni.receipt.preview_failed");
  });
  it("trims long reasons to 300 characters", () => {
    expect(receiptFailureEntry("preview", owner, "j", new Error("a".repeat(900))).detail.reason).toHaveLength(300);
  });
});

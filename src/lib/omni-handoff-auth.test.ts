import { describe, expect, it } from "vitest";
import {
  evaluateHandoff,
  validateAuthorizationRequest,
  wireKind,
  type HandoffFacts,
} from "./omni-handoff-auth";

const NOW = Date.parse("2026-11-07T17:00:00Z");
const owner = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const inMinutes = (m: number) => new Date(NOW + m * 60_000).toISOString();

function facts(over: Partial<HandoffFacts> = {}): HandoffFacts {
  return {
    isOwner: true,
    actorId: owner,
    killSwitchOn: false,
    link: { verified: true, verifiedAt: minutesAgo(1), configMatches: true },
    project: { id: project, ownerId: owner, enrolled: true, repoUrl: "https://github.com/OMERTA-ROW/Omni" },
    job: {
      projectId: project,
      kind: "code",
      status: "queued",
      sentAt: null,
      codeRequestId: null,
      repo: "OMERTA-ROW/Omni",
      instructions: "Build the inbox worker",
    },
    authorization: {
      projectId: project,
      ownerId: owner,
      kinds: ["code", "test"],
      repo: "OMERTA-ROW/Omni",
      expiresAt: inMinutes(60 * 24),
      revokedAt: null,
    },
    grant: { expiresAt: inMinutes(10), revokedAt: null },
    ...over,
  };
}
const codes = (f: HandoffFacts, stage: "issue" | "use" = "issue") =>
  evaluateHandoff(f, stage, NOW).blockers.map((b) => b.code);

describe("OMNI build/test handoff authorization", () => {
  it("allows a build and a test handoff when every check passes", () => {
    expect(evaluateHandoff(facts(), "use", NOW).allowed).toBe(true);
    expect(evaluateHandoff(facts({ job: { ...facts().job, kind: "test" } }), "use", NOW).allowed).toBe(true);
  });

  it("requires a verified live link", () => {
    expect(codes(facts({ link: { verified: false, verifiedAt: null, configMatches: false } }))).toContain("link");
  });

  it("refuses a link verified more than 5 minutes ago", () => {
    expect(codes(facts({ link: { verified: true, verifiedAt: minutesAgo(6), configMatches: true } }))).toContain("link_stale");
  });

  it("refuses a link whose settings changed after verification", () => {
    expect(codes(facts({ link: { verified: true, verifiedAt: minutesAgo(1), configMatches: false } }))).toContain("link_config");
  });

  it("requires the owner role", () => {
    expect(codes(facts({ isOwner: false }))).toContain("owner");
  });

  it("refuses a project owned by someone else", () => {
    expect(codes(facts({ project: { ...facts().project!, ownerId: project } }))).toContain("project_owner");
  });

  it("refuses an unenrolled project", () => {
    expect(codes(facts({ project: { ...facts().project!, enrolled: false } }))).toContain("project_enrolled");
  });

  it("refuses a job whose repo differs from the project's repo", () => {
    expect(codes(facts({ job: { ...facts().job, repo: "someone/else" } }))).toContain("project_repo");
  });

  it("requires a project authorization", () => {
    expect(codes(facts({ authorization: null }))).toContain("authorization");
  });

  it("blocks immediately once the project authorization is revoked", () => {
    expect(codes(facts({ authorization: { ...facts().authorization!, revokedAt: minutesAgo(0) } }), "use")).toContain(
      "authorization_revoked",
    );
  });

  it("blocks once the project authorization expires", () => {
    expect(codes(facts({ authorization: { ...facts().authorization!, expiresAt: minutesAgo(1) } }))).toContain(
      "authorization_expired",
    );
  });

  it("refuses a build when only tests are authorized", () => {
    expect(codes(facts({ authorization: { ...facts().authorization!, kinds: ["test"] } }))).toContain(
      "authorization_scope",
    );
  });

  it("refuses an authorization granted for a different project", () => {
    expect(
      codes(facts({ authorization: { ...facts().authorization!, projectId: owner } })),
    ).toContain("authorization_scope");
  });

  it("blocks everything while the Kill Switch is on", () => {
    expect(codes(facts({ killSwitchOn: true }))).toContain("kill_switch");
  });

  it("refuses CODE requests and already-sent jobs", () => {
    expect(codes(facts({ job: { ...facts().job, codeRequestId: owner } }))).toContain("job_code");
    expect(codes(facts({ job: { ...facts().job, status: "sent", sentAt: minutesAgo(1) } }))).toContain("job_state");
  });

  it("refuses a revoked or expired job approval when using it", () => {
    expect(codes(facts({ grant: { expiresAt: inMinutes(5), revokedAt: minutesAgo(0) } }), "use")).toContain("grant_revoked");
    expect(codes(facts({ grant: { expiresAt: minutesAgo(1), revokedAt: null } }), "use")).toContain("grant_expired");
    expect(codes(facts({ grant: null }), "use")).toContain("grant");
  });

  it("limits project authorization to build/test and 1–30 days", () => {
    expect(validateAuthorizationRequest({ kinds: ["code"], days: 7 })).toBeNull();
    expect(validateAuthorizationRequest({ kinds: [], days: 7 })).not.toBeNull();
    expect(validateAuthorizationRequest({ kinds: ["deploy"], days: 7 })).not.toBeNull();
    expect(validateAuthorizationRequest({ kinds: ["test"], days: 31 })).not.toBeNull();
  });

  it("sends builds to OMNI as `build`", () => {
    expect(wireKind("code")).toBe("build");
    expect(wireKind("test")).toBe("test");
  });
});

describe("link-loss revocation stays in sync with the database trigger", () => {
  it("uses the exact aged-link message the trigger exempts", async () => {
    const { readFileSync } = await import("node:fs");
    const { LINK_AGED_MESSAGE } = await import("./omni-handoff-auth");
    const sql = readFileSync("drizzle/migrations/0052_omni_handoff_authorization.sql", "utf8");
    expect(sql).toContain(`'${LINK_AGED_MESSAGE}'`);
  });
});

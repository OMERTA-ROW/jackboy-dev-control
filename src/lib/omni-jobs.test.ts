import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OMNI_CHAT_EXECUTION_BLOCKED,
  omniChallenge,
  omniFailure,
  omniJobBody,
  parseAllowedRepos,
  parseOmniStatus,
  pickOmniRepo,
  validateOmniJob,
} from "./omni-jobs";

const pause = vi.hoisted(() => ({ reason: null as string | null }));
const logs = vi.hoisted(() => [] as { action: string }[]);
vi.mock("./global-pause.server", () => ({
  assertWorkAllowed: async () => {
    if (pause.reason) throw new Error(pause.reason);
  },
}));
vi.mock("./site-log.server", () => ({
  logSite: async (e: { action: string }) => {
    logs.push(e);
  },
}));

const REPO = "OMERTA-ROW/Omni";

describe("OMNI job rules", () => {
  it("builds the exact omni.job/v1 body", () => {
    expect(
      omniJobBody("11111111-1111-4111-8111-111111111111", {
        kind: "test",
        repo: REPO,
        instructions: " echo handshake-ok ",
      }),
    ).toEqual({
      contract: "omni.job/v1",
      jobId: "11111111-1111-4111-8111-111111111111",
      kind: "test",
      repo: REPO,
      instructions: "echo handshake-ok",
    });
  });
  it("only uses repositories on Jackboy's OMNI list", () => {
    const allowed = parseAllowedRepos(` ${REPO}, bad name ,OMERTA-ROW/jackboy-dev-control`);
    expect(allowed).toEqual([REPO, "OMERTA-ROW/jackboy-dev-control"]);
    expect(pickOmniRepo(undefined, allowed)).toEqual({ repo: REPO });
    expect(pickOmniRepo("someone/else", allowed)).toHaveProperty("error");
    expect(pickOmniRepo(undefined, [])).toHaveProperty("error");
    expect(pickOmniRepo("someone/else", [])).toHaveProperty("error");
    expect(pickOmniRepo("someone/else", parseAllowedRepos("invalid list"))).toHaveProperty("error");
  });
  it("rejects bad kinds, empty or oversized instructions", () => {
    expect(
      validateOmniJob({ kind: "deploy" as never, repo: REPO, instructions: "x" }),
    ).not.toBeNull();
    expect(validateOmniJob({ kind: "test", repo: REPO, instructions: "  " })).not.toBeNull();
    expect(
      validateOmniJob({ kind: "test", repo: REPO, instructions: "x".repeat(4001) }),
    ).not.toBeNull();
  });
  it("always names the HTTP status and says the job did not run", () => {
    expect(omniFailure(401, "unauthorized")).toBe(
      "OMNI answered HTTP 401: unauthorized. The job did not run.",
    );
    expect(omniFailure(null, "timed out after 15 seconds")).toMatch(
      /could not be reached.*did not run/,
    );
  });
  it("makes a 32–200 character hex challenge", () => {
    const c = omniChallenge();
    expect(c).toMatch(/^[0-9a-f]+$/);
    expect(c.length).toBeGreaterThanOrEqual(32);
    expect(c.length).toBeLessThanOrEqual(200);
  });
  it("reads OMNI's job status and output", () => {
    const s = parseOmniStatus({
      id: "11111111-1111-4111-8111-111111111111",
      status: "failed",
      result: {
        status: "failed",
        summary: "Tests failed",
        tests: { passed: false, output: "FAIL x" },
      },
    });
    expect(s?.result?.tests).toEqual({ passed: false, output: "FAIL x" });
    expect(parseOmniStatus({ status: "ok" })).toBeNull();
  });
});

describe("chat cannot bypass project and exact-job authorization", () => {
  beforeEach(() => {
    vi.stubEnv("OMNI_API_URL", "https://omni.example");
    vi.stubEnv("OMNI_API_KEY", "k".repeat(40));
    vi.stubEnv("OMNI_ALLOWED_REPOS", REPO);
    pause.reason = null;
    logs.length = 0;
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(["code", "test"] as const)(
    "refuses %s execution without making any transport call",
    async (kind) => {
      const { submitOmniJob } = await import("./omni-jobs.server");
      const f = vi.fn();
      const r = await submitOmniJob(
        "owner",
        {
          kind,
          instructions: "Run this typed request",
          patch: kind === "code" ? "fixture patch" : undefined,
        },
        { fetch: f },
      );
      expect(r).toMatchObject({ sent: false, ran: false, jobId: null, httpStatus: null });
      if (r.sent) throw new Error("Chat must not dispatch.");
      expect(r.error).toContain(OMNI_CHAT_EXECUTION_BLOCKED);
      expect(f).not.toHaveBeenCalled();
      expect(logs).toEqual([
        {
          action: "omni.chat_job.refused",
          actor: "owner",
          category: "delivery",
          status: "failed",
          summary: expect.stringContaining(OMNI_CHAT_EXECUTION_BLOCKED),
          detail: { jobId: null, httpStatus: null },
        },
      ]);
    },
  );

  it.each(["", "invalid list"])(
    "refuses an explicitly requested repository with empty/invalid config %j",
    async (raw) => {
      vi.stubEnv("OMNI_ALLOWED_REPOS", raw);
      const { submitOmniJob } = await import("./omni-jobs.server");
      const f = vi.fn();
      const r = await submitOmniJob(
        "owner",
        { kind: "test", repo: REPO, instructions: "x" },
        { fetch: f },
      );
      expect(r).toMatchObject({
        sent: false,
        error: expect.stringContaining("no OMNI repository is authorized"),
      });
      expect(f).not.toHaveBeenCalled();
    },
  );

  it("continues to read real status without posting work", async () => {
    const { getOmniJob } = await import("./omni-jobs.server");
    const jobId = "11111111-1111-4111-8111-111111111111";
    const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      return Response.json({
        id: jobId,
        status: "completed",
        result: { summary: "Actual fixture result" },
      });
    });
    const r = await getOmniJob(jobId, f);
    expect(r).toMatchObject({ ok: true, httpStatus: 200, job: { id: jobId, status: "completed" } });
    expect(f).toHaveBeenCalledOnce();
  });

  it("sends nothing while the Kill Switch is on", async () => {
    const { submitOmniJob } = await import("./omni-jobs.server");
    pause.reason = "The Kill Switch is on.";
    const f = vi.fn();
    const r = await submitOmniJob(
      "owner",
      { kind: "test", instructions: "x" },
      { fetch: f as never },
    );
    expect(r.sent).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses a repository outside the list without calling OMNI", async () => {
    const { submitOmniJob } = await import("./omni-jobs.server");
    const f = vi.fn();
    const r = await submitOmniJob(
      "owner",
      { kind: "test", repo: "evil/repo", instructions: "x" },
      { fetch: f as never },
    );
    expect(r.sent).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("voice can't send OMNI jobs", async () => {
    const { decideTool } = await import("./voice-guard");
    expect(
      decideTool("sendOmniJob", [
        {
          role: "user",
          metadata: { voice: true },
          parts: [{ type: "text", text: "send a job to OMNI" }],
        },
      ]).allow,
    ).toBe(false);
    expect(
      decideTool("sendOmniJob", [
        { role: "user", parts: [{ type: "text", text: "send a job to OMNI" }] },
      ]).allow,
    ).toBe(true);
  });
});

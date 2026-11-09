import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { omniChallenge, omniFailure, omniJobBody, parseAllowedRepos, parseOmniStatus, pickOmniRepo, validateOmniJob } from "./omni-jobs";

const pause = vi.hoisted(() => ({ reason: null as string | null }));
const logs = vi.hoisted(() => [] as { action: string }[]);
vi.mock("./global-pause.server", () => ({ assertWorkAllowed: async () => { if (pause.reason) throw new Error(pause.reason); } }));
vi.mock("./site-log.server", () => ({ logSite: async (e: { action: string }) => { logs.push(e); } }));

const REPO = "OMERTA-ROW/Omni";
const ID = /^[0-9a-f-]{36}$/;

describe("OMNI job rules", () => {
  it("builds the exact omni.job/v1 body", () => {
    expect(omniJobBody("11111111-1111-4111-8111-111111111111", { kind: "test", repo: REPO, instructions: " echo handshake-ok " })).toEqual({
      contract: "omni.job/v1", jobId: "11111111-1111-4111-8111-111111111111", kind: "test", repo: REPO, instructions: "echo handshake-ok",
    });
  });
  it("only uses repositories on Jackboy's OMNI list", () => {
    const allowed = parseAllowedRepos(` ${REPO}, bad name ,OMERTA-ROW/jackboy-dev-control`);
    expect(allowed).toEqual([REPO, "OMERTA-ROW/jackboy-dev-control"]);
    expect(pickOmniRepo(undefined, allowed)).toEqual({ repo: REPO });
    expect(pickOmniRepo("someone/else", allowed)).toHaveProperty("error");
    expect(pickOmniRepo(undefined, [])).toHaveProperty("error");
  });
  it("rejects bad kinds, empty or oversized instructions", () => {
    expect(validateOmniJob({ kind: "deploy" as never, repo: REPO, instructions: "x" })).not.toBeNull();
    expect(validateOmniJob({ kind: "test", repo: REPO, instructions: "  " })).not.toBeNull();
    expect(validateOmniJob({ kind: "test", repo: REPO, instructions: "x".repeat(4001) })).not.toBeNull();
  });
  it("always names the HTTP status and says the job did not run", () => {
    expect(omniFailure(401, "unauthorized")).toBe("OMNI answered HTTP 401: unauthorized. The job did not run.");
    expect(omniFailure(null, "timed out after 15 seconds")).toMatch(/could not be reached.*did not run/);
  });
  it("makes a 32–200 character hex challenge", () => {
    const c = omniChallenge();
    expect(c).toMatch(/^[0-9a-f]+$/);
    expect(c.length).toBeGreaterThanOrEqual(32);
    expect(c.length).toBeLessThanOrEqual(200);
  });
  it("reads OMNI's job status and output", () => {
    const s = parseOmniStatus({ id: "11111111-1111-4111-8111-111111111111", status: "failed", result: { status: "failed", summary: "Tests failed", tests: { passed: false, output: "FAIL x" } } });
    expect(s?.result?.tests).toEqual({ passed: false, output: "FAIL x" });
    expect(parseOmniStatus({ status: "ok" })).toBeNull();
  });
});

describe("submitOmniJob sends a real request and never invents output", () => {
  beforeEach(() => {
    vi.stubEnv("OMNI_API_URL", "https://omni.example");
    vi.stubEnv("OMNI_API_KEY", "k".repeat(40));
    vi.stubEnv("OMNI_ALLOWED_REPOS", REPO);
    pause.reason = null;
    logs.length = 0;
  });
  afterEach(() => vi.unstubAllEnvs());

  it("posts to /jackboy/jobs with the bearer and matching Idempotency-Key, then returns OMNI's output", async () => {
    const { submitOmniJob } = await import("./omni-jobs.server");
    let sentId = "";
    const f = vi.fn(async (url: string, init: RequestInit) => {
      const h = new Headers(init.headers);
      if (init.method === "POST") {
        expect(url).toBe("https://omni.example/jackboy/jobs");
        expect(h.get("authorization")).toBe(`Bearer ${"k".repeat(40)}`);
        const body = JSON.parse(String(init.body));
        sentId = body.jobId;
        expect(h.get("idempotency-key")).toBe(sentId);
        expect(body).toMatchObject({ contract: "omni.job/v1", kind: "test", repo: REPO, instructions: "echo handshake-ok" });
        return Response.json({ accepted: true, ref: sentId, duplicate: false, status: "queued" }, { status: 202 });
      }
      expect(url).toBe(`https://omni.example/jackboy/jobs/${sentId}`);
      return Response.json({ id: sentId, status: "completed", result: { status: "completed", summary: "tests passed", tests: { passed: true, output: "ok  ./..." } } });
    });
    const r = await submitOmniJob("owner", { kind: "test", instructions: "echo handshake-ok" }, { fetch: f as never, pollMs: 1 });
    expect(r.sent).toBe(true);
    if (!r.sent) return;
    expect(r.jobId).toMatch(ID);
    expect(r.httpStatus).toBe(202);
    expect(r.status).toBe("completed");
    expect(r.result?.tests?.output).toBe("ok  ./...");
    expect(JSON.stringify(r)).not.toContain("handshake-ok\n");
  });

  it.each([[401, "unauthorized"], [400, "wrong contract"], [403, "repository not allowed"]])("shows HTTP %i from OMNI and says the job did not run", async (status, text) => {
    const { submitOmniJob } = await import("./omni-jobs.server");
    const f = vi.fn(async () => new Response(text, { status }));
    const r = await submitOmniJob("owner", { kind: "test", instructions: "x" }, { fetch: f as never });
    expect(r).toMatchObject({ sent: false, ran: false, httpStatus: status, error: `OMNI answered HTTP ${status}: ${text}. The job did not run.` });
  });

  it("reports a network failure or timeout without an HTTP status", async () => {
    const { submitOmniJob } = await import("./omni-jobs.server");
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    const r = await submitOmniJob("owner", { kind: "test", instructions: "x" }, { fetch: vi.fn(async () => { throw timeout; }) as never });
    expect(r).toMatchObject({ sent: false, httpStatus: null });
    if (!r.sent) expect(r.error).toMatch(/timed out.*did not run/);
  });

  it("sends nothing while the Kill Switch is on", async () => {
    const { submitOmniJob } = await import("./omni-jobs.server");
    pause.reason = "The Kill Switch is on.";
    const f = vi.fn();
    const r = await submitOmniJob("owner", { kind: "test", instructions: "x" }, { fetch: f as never });
    expect(r.sent).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses a repository outside the list without calling OMNI", async () => {
    const { submitOmniJob } = await import("./omni-jobs.server");
    const f = vi.fn();
    const r = await submitOmniJob("owner", { kind: "test", repo: "evil/repo", instructions: "x" }, { fetch: f as never });
    expect(r.sent).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses when OMNI's 202 does not confirm this job", async () => {
    const { submitOmniJob } = await import("./omni-jobs.server");
    const f = vi.fn(async () => Response.json({ accepted: true, ref: "22222222-2222-4222-8222-222222222222", status: "queued" }, { status: 202 }));
    const r = await submitOmniJob("owner", { kind: "test", instructions: "x" }, { fetch: f as never });
    expect(r.sent).toBe(false);
  });

  it("voice can't send OMNI jobs", async () => {
    const { decideTool } = await import("./voice-guard");
    expect(decideTool("sendOmniJob", [{ role: "user", metadata: { voice: true }, parts: [{ type: "text", text: "send a job to OMNI" }] }]).allow).toBe(false);
    expect(decideTool("sendOmniJob", [{ role: "user", parts: [{ type: "text", text: "send a job to OMNI" }] }]).allow).toBe(true);
  });
});

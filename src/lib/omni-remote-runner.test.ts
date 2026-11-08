import { describe, expect, it } from "vitest";
import { hmacHex } from "./omni-link";
import {
  callRemoteRunner,
  nonceCache,
  remoteRunnerConfig,
  runnerConfigProblem,
  runnerModeDecision,
  runnerOrigin,
  requestMessage,
  responseMessage,
  verifyRunnerRequest,
} from "./omni-remote-runner";
import { handleRunnerRequest } from "./omni-remote-runner.server";

const SECRET = "r".repeat(40);
const JOB = "11111111-2222-4333-8444-555555555555";
const env = { OMNI_LINK_RUNNER_MODE: "true", OMNI_LINK_REMOTE_RUNNER_SECRET: SECRET };
const cfg = { url: "https://runner.example/api/public/omni/runner", secret: SECRET };

async function signed(body: string, ts = String(Date.now()), nonce = "n".repeat(32), secret = SECRET) {
  return new Request(cfg.url, {
    method: "POST",
    headers: {
      "X-Runner-Timestamp": ts,
      "X-Runner-Nonce": nonce,
      "X-Runner-Signature": await hmacHex(secret, requestMessage(ts, nonce, body)),
    },
    body,
  });
}
const body = JSON.stringify({ kind: "protocol.self-test", jobId: JOB });
const run = (req: Request, opts: { passed?: boolean; claim?: ReturnType<typeof nonceCache>; e?: Record<string, string> } = {}) =>
  handleRunnerRequest(req, opts.e ?? env, async () => opts.passed ?? true, () => true, opts.claim ?? nonceCache());

describe("remote runner config (live site)", () => {
  it("requires enabled flag, https origin and a strong secret", () => {
    const ok = { OMNI_LINK_REMOTE_RUNNER_ENABLED: "true", OMNI_LINK_REMOTE_RUNNER_URL: "https://x.up.railway.app", OMNI_LINK_REMOTE_RUNNER_SECRET: SECRET };
    expect(remoteRunnerConfig(ok)?.url).toBe("https://x.up.railway.app/api/public/omni/runner");
    expect(remoteRunnerConfig({ ...ok, OMNI_LINK_REMOTE_RUNNER_ENABLED: "false" })).toBeNull();
    expect(remoteRunnerConfig({ ...ok, OMNI_LINK_REMOTE_RUNNER_URL: "http://x.up.railway.app" })).toBeNull();
    expect(remoteRunnerConfig({ ...ok, OMNI_LINK_REMOTE_RUNNER_URL: "https://x.app/other" })).toBeNull();
    expect(remoteRunnerConfig({ ...ok, OMNI_LINK_REMOTE_RUNNER_SECRET: "short" })).toBeNull();
  });
});

describe("runner endpoint (runner-only host)", () => {
  it("is 404 when runner mode is off", async () => {
    expect((await run(await signed(body), { e: { OMNI_LINK_REMOTE_RUNNER_SECRET: SECRET } })).status).toBe(404);
  });
  it("rejects a bad signature", async () => {
    expect((await run(await signed(body, undefined, undefined, "x".repeat(40)))).status).toBe(401);
  });
  it("rejects a stale timestamp", async () => {
    expect((await run(await signed(body, String(Date.now() - 120_000)))).status).toBe(401);
  });
  it("rejects a reused nonce", async () => {
    const claim = nonceCache();
    expect((await run(await signed(body), { claim })).status).toBe(200);
    expect((await run(await signed(body), { claim })).status).toBe(401);
  });
  it("rejects other kinds or extra fields", async () => {
    expect((await run(await signed(JSON.stringify({ kind: "shell", jobId: JOB })))).status).toBe(400);
    expect((await run(await signed(JSON.stringify({ kind: "protocol.self-test", jobId: JOB, cmd: "x" })))).status).toBe(400);
  });
});

describe("round trip", () => {
  const viaRunner = (passed: boolean, claim = nonceCache()): typeof fetch =>
    (async (_u: string, init: RequestInit) => run(new Request(cfg.url, init as RequestInit), { passed, claim })) as unknown as typeof fetch;
  it("records a real pass", async () => {
    expect(await callRemoteRunner(cfg, JOB, new AbortController().signal, viaRunner(true))).toEqual({ passed: true });
  });
  it("records a real fail", async () => {
    expect(await callRemoteRunner(cfg, JOB, new AbortController().signal, viaRunner(false))).toEqual({ passed: false });
  });
  it("unreachable runner is a failure, never a pass", async () => {
    const down = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await callRemoteRunner(cfg, JOB, new AbortController().signal, down)).toEqual({ passed: false, error: "runner_unreachable" });
  });
  it("forged or wrong-job proof is rejected", async () => {
    const forged = (async (_u: string, init: RequestInit) => {
      const nonce = new Headers(init.headers).get("x-runner-nonce")!;
      const out = JSON.stringify({ jobId: "99999999-2222-4333-8444-555555555555", nonce, passed: true });
      return new Response(out, { headers: { "X-Runner-Proof": await hmacHex(SECRET, responseMessage(nonce, out)) } });
    }) as unknown as typeof fetch;
    expect((await callRemoteRunner(cfg, JOB, new AbortController().signal, forged)).error).toBe("runner_proof_invalid");
    const unsigned = (async () => new Response(JSON.stringify({ passed: true }))) as unknown as typeof fetch;
    expect((await callRemoteRunner(cfg, JOB, new AbortController().signal, unsigned)).error).toBe("runner_proof_invalid");
  });
  it("verifier refuses replays directly", async () => {
    const claim = nonceCache();
    const h = (await signed(body)).headers;
    expect("jobId" in (await verifyRunnerRequest(SECRET, h, body, claim))).toBe(true);
    expect(await verifyRunnerRequest(SECRET, h, body, claim)).toEqual({ error: "replayed_request" });
  });
});

describe("runnerOrigin (Railway host as shown in Railway)", () => {
  it("reads a bare Railway host as https and never as http", () => {
    expect(runnerOrigin("x.up.railway.app")).toBe("https://x.up.railway.app");
    expect(runnerOrigin(" https://x.up.railway.app/ ")).toBe("https://x.up.railway.app");
    expect(runnerOrigin("http://x.up.railway.app")).toBeNull();
    expect(runnerOrigin("x.up.railway.app/api/public/omni/runner")).toBeNull();
  });
  it("names the blocking runner setting without values", () => {
    const ok = { OMNI_LINK_REMOTE_RUNNER_ENABLED: "true", OMNI_LINK_REMOTE_RUNNER_SECRET: "s".repeat(32), OMNI_LINK_REMOTE_RUNNER_URL: "x.up.railway.app" };
    expect(runnerConfigProblem(ok)).toBeNull();
    expect(remoteRunnerConfig(ok)?.url).toBe("https://x.up.railway.app/api/public/omni/runner");
    expect(runnerConfigProblem({ ...ok, OMNI_LINK_REMOTE_RUNNER_URL: "http://x" })).toContain("OMNI_LINK_REMOTE_RUNNER_URL");
    expect(runnerConfigProblem({ ...ok, OMNI_LINK_REMOTE_RUNNER_SECRET: "zq9-private" })).not.toContain("zq9-private");
  });
});

describe("runner-mode guard (dashboard hosts ignore a misplaced OMNI_LINK_RUNNER_MODE)", () => {
  it("stays on for a plain runner host with only runner settings", () => {
    expect(runnerModeDecision(env, "jackboy-runner.up.railway.app")).toEqual({ on: true });
  });
  it("is off when runner mode is not exactly true", () => {
    expect(runnerModeDecision({ ...env, OMNI_LINK_RUNNER_MODE: "TRUE" }, "x.up.railway.app").on).toBe(false);
  });
  it.each(["jackboy-dev-control.lovable.app", "id-preview--abc.lovable.app", "abc.lovableproject.com", "localhost"])(
    "is ignored on dashboard host %s",
    (host) => expect(runnerModeDecision(env, host)).toEqual({ on: false, ignored: "lovable_host" }),
  );
  it.each([
    ["SUPABASE_SERVICE_ROLE_KEY", "k"],
    ["OMNI_LINK_REMOTE_RUNNER_URL", "https://x.up.railway.app"],
    ["OMNI_LINK_REMOTE_RUNNER_ENABLED", "true"],
  ])("is ignored when the site-only setting %s is present", (k, v) => {
    expect(runnerModeDecision({ ...env, [k]: v }, "x.up.railway.app")).toEqual({ on: false, ignored: "site_settings" });
  });
  it("runner endpoint refuses signed requests on a dashboard host", async () => {
    const req = await signed(body);
    const onDashboard = new Request("https://jackboy-dev-control.lovable.app/api/public/omni/runner", {
      method: "POST", headers: req.headers, body,
    });
    expect((await run(onDashboard)).status).toBe(404);
  });
});

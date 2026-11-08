import { describe, expect, it } from "vitest";
import { hmacHex } from "./omni-link";
import { digest, LINK_PATH, requestMessage } from "./omni-session";
import { handleOmniLink, type LinkConfig, type LinkStore } from "./omni-session.server";
import {
  ENABLED_NOT_EXACT,
  remoteRunnerConfig,
  remoteRunnerDiagnostic,
  runnerConfigProblem,
} from "./omni-remote-runner";

const runner = {
  OMNI_LINK_REMOTE_RUNNER_ENABLED: "true",
  OMNI_LINK_REMOTE_RUNNER_URL: "https://runner.up.railway.app",
  OMNI_LINK_REMOTE_RUNNER_SECRET: "r".repeat(48),
};

describe("remote runner switch must be exactly lowercase true", () => {
  for (const v of ["True", "TRUE", " true", "true\n", '"true"']) {
    it(`keeps the runner off for ${JSON.stringify(v)} and names the exact-value problem`, () => {
      const env = { ...runner, OMNI_LINK_REMOTE_RUNNER_ENABLED: v };
      expect(remoteRunnerConfig(env)).toBeNull();
      expect(runnerConfigProblem(env)).toBe(ENABLED_NOT_EXACT);
      expect(remoteRunnerDiagnostic(env)).toContain("not exactly lowercase true");
      expect(remoteRunnerDiagnostic(env)).not.toContain("disabled");
    });
  }
  it("still reports a missing or false switch as disabled", () => {
    expect(remoteRunnerDiagnostic({ ...runner, OMNI_LINK_REMOTE_RUNNER_ENABLED: "false" })).toContain("disabled");
    expect(runnerConfigProblem({ ...runner, OMNI_LINK_REMOTE_RUNNER_ENABLED: undefined })).toBe(
      "OMNI_LINK_REMOTE_RUNNER_ENABLED is not exactly true",
    );
  });
  it("accepts exactly true", () => {
    expect(remoteRunnerConfig(runner)).not.toBeNull();
    expect(runnerConfigProblem(runner)).toBeNull();
  });
});

describe("handshake readiness", () => {
  const config: LinkConfig = {
    clientId: "OMNI",
    projectId: "11111111-1111-4111-8111-111111111111",
    ownerId: "22222222-2222-4222-8222-222222222222",
    approvalId: "33333333-3333-4333-8333-333333333333",
    approvalExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    bootstrap: "b".repeat(64),
    secret: "s".repeat(64),
  };
  const store: LinkStore = async (op) =>
    op === "handshake" ? { http: 200, expiresAt: new Date(Date.now() + 300_000).toISOString() } : { http: 200 };
  async function signedHandshake() {
    const body = JSON.stringify({ action: "handshake", projectId: config.projectId });
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = "a".repeat(32);
    const sig = await hmacHex(config.secret, requestMessage(ts, nonce, await digest(config.bootstrap), body));
    return new Request("https://jackboy.test" + LINK_PATH, {
      method: "POST",
      body,
      headers: {
        authorization: `Bearer ${config.bootstrap}`,
        "x-omni-client": config.clientId,
        "x-omni-nonce": nonce,
        "x-omni-timestamp": ts,
        "x-omni-signature": sig,
      },
    });
  }

  it("answers ready:false and records which runner setting blocks it when the switch is not exact", async () => {
    const seen: string[] = [];
    const res = await handleOmniLink(
      await signedHandshake(),
      config,
      store,
      undefined,
      { ...runner, OMNI_LINK_REMOTE_RUNNER_ENABLED: "True" },
      fetch,
      async (problem) => {
        seen.push(problem);
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ready).toBe(false);
    expect(seen).toEqual([ENABLED_NOT_EXACT]);
    expect(JSON.stringify(seen)).not.toContain(runner.OMNI_LINK_REMOTE_RUNNER_SECRET);
  });

  it("answers ready:true and records nothing when the remote runner is configured", async () => {
    const seen: string[] = [];
    const res = await handleOmniLink(await signedHandshake(), config, store, undefined, runner, fetch, async (p) => {
      seen.push(p);
    });
    expect((await res.json()).ready).toBe(true);
    expect(seen).toEqual([]);
  });

  it("never lets a logging failure change the answer", async () => {
    const res = await handleOmniLink(await signedHandshake(), config, store, undefined, {}, fetch, async () => {
      throw new Error("log down");
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ready).toBe(false);
  });
});

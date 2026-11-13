import { describe, expect, it, vi } from "vitest";
import { handleOmniConfiguration, handleOmniLinkRequest } from "./omni-configuration.server";
import * as session from "./omni-session.server";
import { handleRunnerRequest } from "./omni-remote-runner.server";
import { nonceCache } from "./omni-remote-runner";
import { digest, requestMessage, LINK_CONTRACT } from "./omni-session";
import { hmacHex } from "./omni-link";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SECRET = "s".repeat(64);
const RUNNER_SECRET = "r".repeat(64);
const env = {
  OMNI_LINK_CLIENT_ID: "mothership-test",
  OMNI_LINK_PROJECT_ID: PROJECT,
  OMNI_LINK_OWNER_ID: "22222222-2222-4222-8222-222222222222",
  OMNI_LINK_BOOTSTRAP_KEY: "b".repeat(64),
  OMNI_LINK_HMAC_SECRET: SECRET,
  OMNI_LINK_REMOTE_RUNNER_ENABLED: "true",
  OMNI_LINK_REMOTE_RUNNER_URL: "https://runner.up.railway.app",
  OMNI_LINK_REMOTE_RUNNER_SECRET: RUNNER_SECRET,
};
async function request(extra: Record<string, unknown> = {}, secret = SECRET) {
  const raw = JSON.stringify({ action: "configuration", projectId: PROJECT, ...extra });
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    raw,
    req: new Request("https://jackboy.lovable.app/api/public/omni/link", {
      method: "POST",
      body: raw,
      headers: {
        authorization: `Bearer ${env.OMNI_LINK_BOOTSTRAP_KEY}`,
        "x-omni-client": env.OMNI_LINK_CLIENT_ID,
        "x-omni-nonce": nonce,
        "x-omni-timestamp": ts,
        "x-omni-signature": await hmacHex(
          secret,
          requestMessage(ts, nonce, await digest(env.OMNI_LINK_BOOTSTRAP_KEY), raw),
        ),
      },
    }),
  };
}
describe("Jackboy read-only runner relay", () => {
  it("preserves the disabled execution route's response for an empty body", async () => {
    const config = vi.spyOn(session, "resolvedLinkConfig").mockResolvedValue(null);
    try {
      const response = await handleOmniLinkRequest(
        new Request("https://jackboy.lovable.app/api/public/omni/link", { method: "POST" }),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "link_disabled" });
      const wrapped = {
        url: "https://jackboy.lovable.app/api/public/omni/link",
        method: "POST",
        headers: new Headers(),
        body: null,
      } as unknown as Request;
      expect((await handleOmniLinkRequest(wrapped)).status).toBe(503);
    } finally {
      config.mockRestore();
    }
  });
  it("relays nonce-bound metadata while execution flags and approval expiry remain unset", async () => {
    const execute = vi.fn(async () => true);
    const allow = vi.fn(async () => true);
    const fetcher: typeof fetch = async (url, init) =>
      handleRunnerRequest(
        new Request(url, init),
        {
          OMNI_LINK_RUNNER_MODE: "true",
          OMNI_LINK_NODE_RUNNER_ENABLED: "true",
          OMNI_LINK_REMOTE_RUNNER_SECRET: RUNNER_SECRET,
        },
        execute,
        () => true,
        nonceCache(),
      );
    const { req, raw } = await request();
    const response = await handleOmniConfiguration(req, raw, env, allow, fetcher);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(response.headers.get("x-omni-proof")).toBe(
      await hmacHex(
        SECRET,
        `${LINK_CONTRACT}\nresponse\n${req.headers.get("x-omni-nonce")}\n200\n${body}`,
      ),
    );
    const out = JSON.parse(body);
    expect(out.execution).toBe("none");
    expect(out.configuration).toEqual({
      runnerOrigin: "https://runner.up.railway.app",
      runnerMode: true,
      nodeRunnerEnabled: true,
      remoteRunnerSecretConfigured: true,
      runtimeAvailable: true,
    });
    expect(body).not.toContain(RUNNER_SECRET);
    expect(body).not.toContain(SECRET);
    expect(execute).not.toHaveBeenCalled();
    expect(allow).toHaveBeenCalledOnce();
  });
  it.each(["signature", "project", "extra", "scope", "audit"])(
    "blocks %s failure before contacting Railway",
    async (problem) => {
      const { req, raw } = await request(
        problem === "project"
          ? { projectId: "33333333-3333-4333-8333-333333333333" }
          : problem === "extra"
            ? { jobId: PROJECT }
            : {},
        problem === "signature" ? RUNNER_SECRET : SECRET,
      );
      const allow = vi.fn(async () => {
        if (problem === "audit") throw new Error("fixture unavailable");
        return problem !== "scope";
      });
      const fetcher = vi.fn<typeof fetch>();
      const response = await handleOmniConfiguration(req, raw, env, allow, fetcher);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("returns signed unresolved evidence when remote configuration or proof is unavailable", async () => {
    const { req, raw } = await request();
    const missing = await handleOmniConfiguration(
      req.clone(),
      raw,
      { ...env, OMNI_LINK_REMOTE_RUNNER_URL: "" },
      async () => true,
    );
    expect((await missing.json()).configuration).toBeNull();
    const forged = await handleOmniConfiguration(
      req,
      raw,
      env,
      async () => true,
      async () => Response.json({ passed: true }),
    );
    expect((await forged.json()).configuration).toBeNull();
  });
});

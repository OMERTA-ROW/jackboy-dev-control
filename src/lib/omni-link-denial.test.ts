import { describe, expect, it } from "vitest";
import { hmacHex } from "./omni-link";
import { checkForReason, denialDetail, denialSummary, type DenialFacts } from "./omni-link-denial";
import { digest, diagnoseRequest, LINK_PATH, requestMessage } from "./omni-session";
import { handleOmniLink, type LinkConfig, type LinkStore } from "./omni-session.server";

const config: LinkConfig = {
  clientId: "omni-test",
  projectId: "11111111-1111-4111-8111-111111111111",
  ownerId: "22222222-2222-4222-8222-222222222222",
  approvalId: "33333333-3333-4333-8333-333333333333",
  approvalExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  bootstrap: "b".repeat(64),
  secret: "s".repeat(64),
};
const SECRET_VALUES = [config.bootstrap, config.secret, config.approvalId, config.ownerId, "x".repeat(64), "w".repeat(64)];

async function request(
  opts: {
    token?: string;
    secret?: string;
    client?: string | null;
    tsOffset?: number;
    body?: Record<string, unknown>;
    auth?: string | null;
  } = {},
) {
  const token = opts.token ?? config.bootstrap;
  const body = JSON.stringify(opts.body ?? { action: "handshake", projectId: config.projectId });
  const ts = String(Math.floor(Date.now() / 1000) - (opts.tsOffset ?? 0));
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const signature = await hmacHex(opts.secret ?? config.secret, requestMessage(ts, nonce, await digest(token), body));
  const headers: Record<string, string> = {
    "x-omni-nonce": nonce,
    "x-omni-timestamp": ts,
    "x-omni-signature": signature,
  };
  if (opts.auth !== null) headers.authorization = opts.auth ?? "Bearer " + token;
  if (opts.client !== null) headers["x-omni-client"] = opts.client ?? config.clientId;
  return new Request("https://jackboy.test" + LINK_PATH, { method: "POST", headers, body });
}

async function run(req: Request, store: LinkStore = async () => ({ http: 200 })) {
  const logged: DenialFacts[] = [];
  const res = await handleOmniLink(req, config, store, async () => false, {}, fetch, async (f) => {
    logged.push(f);
  });
  return { res, logged };
}

describe("OMNI link names the refusing check without values", () => {
  it("wrong HMAC secret → signature, with clock skew", async () => {
    const { res, logged } = await run(await request({ secret: "w".repeat(64) }));
    expect(res.status).toBe(401);
    expect(logged).toHaveLength(1);
    expect(logged[0]!.check).toBe("signature");
    expect(typeof logged[0]!.skewSeconds).toBe("number");
    expect(Math.abs(logged[0]!.skewSeconds!)).toBeLessThanOrEqual(2);
  });
  it("matching secret but wrong bootstrap key → bootstrap_key (signature passed)", async () => {
    const { res, logged } = await run(await request({ token: "x".repeat(64) }));
    expect(res.status).toBe(401);
    expect(logged[0]!.check).toBe("bootstrap_key");
  });
  it("client ID differences: case only, mismatch, missing", async () => {
    expect((await run(await request({ client: "OMNI-test" }))).logged[0]).toMatchObject({ check: "client_id", clientHeader: "case_only" });
    expect((await run(await request({ client: "other" }))).logged[0]).toMatchObject({ check: "client_id", clientHeader: "mismatch" });
    expect((await run(await request({ client: null }))).logged[0]).toMatchObject({ check: "client_id", clientHeader: "missing" });
  });
  it("missing or malformed Authorization → token_format", async () => {
    expect((await run(await request({ auth: null }))).logged[0]).toMatchObject({ check: "token_format", authHeader: "missing" });
    expect((await run(await request({ auth: "Bearer " + "b".repeat(63) + "." }))).logged[0]).toMatchObject({ check: "token_format", authHeader: "bad_token_format" });
    expect((await run(await request({ auth: "Token abc" }))).logged[0]).toMatchObject({ check: "token_format", authHeader: "not_bearer" });
  });
  it("clock more than 60s apart → clock_skew with the difference in seconds", async () => {
    const { logged } = await run(await request({ tsOffset: 125 }));
    expect(logged[0]!.check).toBe("clock_skew");
    expect(logged[0]!.skewSeconds).toBeGreaterThanOrEqual(124);
    expect(logged[0]!.skewSeconds).toBeLessThanOrEqual(127);
  });
  it("wrong project ID → project", async () => {
    const { res, logged } = await run(await request({ body: { action: "handshake", projectId: "99999999-9999-4999-8999-999999999999" } }));
    expect(res.status).toBe(403);
    expect(logged[0]).toMatchObject({ check: "project", action: "handshake" });
  });
  it("store refusals map to session/grant/replay", async () => {
    const reply = (error: string, http: number): LinkStore => async (op) => (op === "reject" ? { http: 200 } : { http, error });
    expect((await run(await request(), reply("grant_unavailable", 403))).logged[0]!.check).toBe("grant");
    expect((await run(await request(), reply("replay", 409))).logged[0]!.check).toBe("replay");
    const status = await request({ token: "z".repeat(64), body: { action: "status", projectId: config.projectId, jobId: "44444444-4444-4444-8444-444444444444" } });
    expect((await run(status, reply("session_expired_or_invalid", 401))).logged[0]!.check).toBe("session");
  });
  it("a successful handshake logs no denial, and the protocol answer is unchanged", async () => {
    const { res, logged } = await run(await request());
    expect(res.status).toBe(200);
    expect(logged).toHaveLength(0);
  });
  it("a failing logger never changes the answer", async () => {
    const res = await handleOmniLink(await request({ secret: "w".repeat(64) }), config, async () => ({ http: 200 }), async () => false, {}, fetch, async () => {
      throw new Error("log down");
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("authentication_failed");
  });
  it("logged summary and detail never contain secret or ID values", async () => {
    for (const req of [
      await request({ secret: "w".repeat(64) }),
      await request({ token: "x".repeat(64) }),
      await request({ client: "OMNI-test" }),
      await request({ body: { action: "handshake", projectId: "99999999-9999-4999-8999-999999999999" } }),
    ]) {
      const { logged } = await run(req);
      const text = denialSummary(logged[0]!) + JSON.stringify(denialDetail(logged[0]!));
      for (const v of [...SECRET_VALUES, "99999999-9999-4999-8999-999999999999", "OMNI-test"]) expect(text).not.toContain(v);
      expect(text).not.toContain(config.clientId);
    }
  });
});

describe("pure denial rules", () => {
  it("summary names settings to compare and the skew", () => {
    const s = denialSummary({ check: "signature", reason: "authentication_failed", http: 401, skewSeconds: 3 });
    expect(s).toContain("OMNI_LINK_HMAC_SECRET");
    expect(s).toContain("Clock difference 3s");
    expect(denialSummary({ check: "timestamp_format", reason: "authentication_failed", http: 401, skewSeconds: null })).toContain("unknown");
  });
  it("detail drops unknown actions and odd reasons", () => {
    const d = denialDetail({ check: "other", reason: "Bad <thing> " + "s".repeat(64), http: 400, skewSeconds: 1.6, action: "rm -rf" });
    expect(d).toMatchObject({ reason: "other", action: null, skewSeconds: 2, compare: [] });
  });
  it("maps store reasons", () => {
    expect(checkForReason("project_denied")).toBe("project");
    expect(checkForReason("whatever")).toBe("other");
  });
  it("diagnoseRequest flags bad nonce and timestamp separately", async () => {
    const h = new Headers({ "x-omni-timestamp": String(Math.floor(Date.now() / 1000)), "x-omni-nonce": "short" });
    expect(await diagnoseRequest("s".repeat(64), "t".repeat(64), h, "{}")).toMatchObject({ ok: false, check: "nonce_format" });
    expect(await diagnoseRequest("s".repeat(64), "t".repeat(64), new Headers(), "{}")).toMatchObject({ ok: false, check: "timestamp_format", skewSeconds: null });
  });
});

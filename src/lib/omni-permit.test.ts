import { describe, expect, it, vi } from "vitest";
import { handleOmniPermit, type PermitStore } from "./omni-permit.server";
import { autonomyGates, parsePermitInput, permitSigningMessage, permitUsable, signPermit, OMNI_AUTONOMY_LIMITS } from "./omni-permit";
import { digest, requestMessage, LINK_CONTRACT } from "./omni-session";
import { hmacHex } from "./omni-link";
import type { LinkConfig } from "./omni-session.server";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const JOB = "66666666-6666-4666-8666-666666666666";
const SECRET = "s".repeat(64);
const SESSION = "t".repeat(64);
const cfg: LinkConfig = {
  clientId: "OMNI",
  projectId: PROJECT,
  ownerId: "22222222-2222-4222-8222-222222222222",
  approvalId: "44444444-4444-4444-8444-444444444444",
  approvalExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
  bootstrap: "b".repeat(64),
  secret: SECRET,
};
const DIG = "d".repeat(64);
const reqBody = (extra: Record<string, unknown> = {}) => ({ action: "permit.request", projectId: PROJECT, jobId: JOB, kind: "autonomous", digest: DIG, estimateUsd: 1, ...extra });

async function signed(body: Record<string, unknown>, { token = SESSION, secret = SECRET, client = "OMNI", ts = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(body);
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const t = String(ts);
  return {
    raw,
    nonce,
    req: new Request("https://jackboy.lovable.app/api/public/omni/link", {
      method: "POST",
      body: raw,
      headers: {
        authorization: `Bearer ${token}`,
        "x-omni-client": client,
        "x-omni-nonce": nonce,
        "x-omni-timestamp": t,
        "x-omni-signature": await hmacHex(secret, requestMessage(t, nonce, await digest(token), raw)),
      },
    }),
  };
}
const activePermit = { id: "99999999-9999-4999-8999-999999999999", jobId: JOB, kind: "autonomous", digest: DIG, status: "active", issuedAt: "2026-11-14T01:00:00Z", expiresAt: "2026-11-14T01:01:00Z", renewals: 0, limits: { perCallUsd: 0.5, perTaskUsd: 1, dailyUsd: 5 } };

describe("signed permit actions", () => {
  it("issues a signed permit bound to job, scope, client, project and approval", async () => {
    const store = vi.fn<PermitStore>(async () => ({ http: 200, permit: activePermit }));
    const { req, raw, nonce } = await signed(reqBody());
    const res = await handleOmniPermit(req, raw, cfg, store, {});
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(res.headers.get("x-omni-proof")).toBe(await hmacHex(SECRET, `${LINK_CONTRACT}\nresponse\n${nonce}\n200\n${text}`));
    const body = JSON.parse(text);
    expect(body.permit.contract).toBe("omni.permit/v1");
    expect(body.permit.renewEverySeconds).toBe(20);
    expect(body.permit.signature).toBe(await signPermit(SECRET, { permitId: activePermit.id, jobId: JOB, kind: "autonomous", digest: DIG, clientId: "OMNI", projectId: PROJECT, approvalId: cfg.approvalId, expiresAt: activePermit.expiresAt }));
    const [op, args] = store.mock.calls[0]!;
    expect(op).toBe("request");
    expect(args).toMatchObject({ clientId: "OMNI", projectId: PROJECT, approvalId: cfg.approvalId, jobId: JOB, kind: "autonomous", digest: DIG, estimateUsd: 1, tokenHash: await digest(SESSION), nonce });
  });

  it("passes a stop refusal through signed, with no permit signature", async () => {
    const store = vi.fn<PermitStore>(async () => ({ http: 403, error: "permit_denied", reason: "emergency_stop_engaged", permit: { id: "x", jobId: JOB, status: "revoked" } }));
    const { req, raw } = await signed(reqBody());
    const res = await handleOmniPermit(req, raw, cfg, store, {});
    expect(res.status).toBe(403);
    expect(res.headers.get("x-omni-proof")).toMatch(/^[a-f0-9]{64}$/);
    const body = await res.json();
    expect(body.reason).toBe("emergency_stop_engaged");
    expect(body.permit.signature).toBeUndefined();
  });

  it("fails closed when the permit service is missing or errors", async () => {
    const store = vi.fn<PermitStore>(async () => { throw new Error("relation does not exist"); });
    const { req, raw } = await signed(reqBody());
    const res = await handleOmniPermit(req, raw, cfg, store, {});
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "permit_service_unavailable" });
  });

  it("refuses bad signatures, wrong client, stale timestamps, the bootstrap key, plain http and a disabled link", async () => {
    const store = vi.fn<PermitStore>(async () => ({ http: 200, permit: activePermit }));
    for (const opts of [{ secret: "x".repeat(64) }, { client: "other" }, { ts: Math.floor(Date.now() / 1000) - 120 }, { token: cfg.bootstrap }]) {
      const { req, raw } = await signed(reqBody(), opts);
      expect((await handleOmniPermit(req, raw, cfg, store, {})).status).toBe(401);
    }
    const { req, raw } = await signed(reqBody());
    expect((await handleOmniPermit(new Request(req.url.replace("https:", "http:"), { method: "POST", headers: req.headers, body: raw }), raw, cfg, store, {})).status).toBe(400);
    expect((await handleOmniPermit(req, raw, null, store, {})).status).toBe(503);
    expect(store).not.toHaveBeenCalled();
  });

  it("safety snapshot is signed and labelled", async () => {
    const store = vi.fn<PermitStore>(async () => ({ http: 200, safety: { autonomousAllowed: false, blockedBy: "kill_switch_on", manualDiagnosticsAllowed: false } }));
    const { req, raw } = await signed({ action: "safety", projectId: PROJECT });
    const body = await (await handleOmniPermit(req, raw, cfg, store, {})).json();
    expect(body.safety).toMatchObject({ contract: "omni.safety/v1", autonomousAllowed: false });
    expect(store.mock.calls[0]![0]).toBe("safety");
  });
});

describe("permit input rules", () => {
  it("accepts only exact keys, the configured project and allowed scope", () => {
    expect(parsePermitInput(reqBody(), PROJECT).ok).toBe(true);
    expect(parsePermitInput({ ...reqBody(), extra: 1 }, PROJECT)).toEqual({ ok: false, error: "action_denied" });
    expect(parsePermitInput(reqBody({ projectId: JOB }), PROJECT)).toEqual({ ok: false, error: "project_denied" });
    expect(parsePermitInput(reqBody({ kind: "deploy" }), PROJECT)).toEqual({ ok: false, error: "scope_invalid" });
    expect(parsePermitInput(reqBody({ estimateUsd: 1.01 }), PROJECT)).toEqual({ ok: false, error: "scope_invalid" });
    expect(parsePermitInput(reqBody({ digest: "ABC" }), PROJECT)).toEqual({ ok: false, error: "scope_invalid" });
    expect(parsePermitInput({ action: "permit.release", projectId: PROJECT, jobId: JOB }, PROJECT).ok).toBe(true);
    expect(parsePermitInput({ action: "start", projectId: PROJECT }, PROJECT)).toEqual({ ok: false, error: "action_denied" });
  });
  it("owner limits are $5/day, $0.50/call, $1/job", () => {
    expect(OMNI_AUTONOMY_LIMITS).toEqual({ dailyUsd: 5, perCallUsd: 0.5, perTaskUsd: 1 });
  });
  it("a permit is usable only while active and unexpired", () => {
    const now = Date.parse("2026-11-14T01:00:30Z");
    expect(permitUsable(activePermit, now)).toBe(true);
    expect(permitUsable({ ...activePermit, status: "revoked" }, now)).toBe(false);
    expect(permitUsable(activePermit, Date.parse("2026-11-14T01:01:00Z"))).toBe(false);
    expect(permitSigningMessage({ permitId: "p", jobId: "j", kind: "k", digest: "d", clientId: "c", projectId: "pr", approvalId: "a", expiresAt: "e" })).toBe("omni.permit/v1\np\nj\nk\nd\nc\npr\na\ne");
  });
});

describe("owner gates", () => {
  const now = Date.parse("2026-11-14T01:00:00Z");
  const ready = {
    installed: true, linkConfigured: true,
    approval: { approvalId: "a", expiresAt: "2026-11-14T20:00:00Z" },
    step8ProofAt: "2026-11-14T00:50:00Z", lastHandshakeAt: "2026-11-14T00:55:00Z",
    runnerReady: true, meterOk: true, guardEnforced: true,
    killSwitch: false, emergencyStop: false, codeEnabled: true,
    authorization: { expiresAt: "2026-11-14T20:00:00Z" },
  };
  it("OMNI can run only with every control and the authorization in place", () => {
    expect(autonomyGates(ready, now).omniCanRun).toBe(true);
    for (const patch of [{ killSwitch: true }, { emergencyStop: true }, { codeEnabled: false }, { authorization: null }, { killSwitch: null }, { emergencyStop: null }, { installed: false }]) {
      expect(autonomyGates({ ...ready, ...patch }, now).omniCanRun, JSON.stringify(patch)).toBe(false);
    }
  });
  it("authorizing needs Step 7, Step 8, a Step 9 handshake in the last 30 min, runner, meter and guard; stops don't block authorizing", () => {
    expect(autonomyGates({ ...ready, emergencyStop: true, killSwitch: true }, now).canAuthorize).toBe(true);
    for (const patch of [{ step8ProofAt: null }, { lastHandshakeAt: "2026-11-14T00:29:00Z" }, { approval: { approvalId: "a", expiresAt: "2026-11-14T00:59:00Z" } }, { runnerReady: false }, { meterOk: null }, { guardEnforced: false }, { linkConfigured: false }]) {
      expect(autonomyGates({ ...ready, ...patch }, now).canAuthorize, JSON.stringify(patch)).toBe(false);
    }
  });
});

describe("link endpoint routing", () => {
  it("sends permit actions to the permit handler (unsigned → 401 without touching the database)", async () => {
    const session = await import("./omni-session.server");
    const spy = vi.spyOn(session, "resolvedLinkConfig").mockResolvedValue(cfg);
    try {
      const { handleOmniLinkRequest } = await import("./omni-configuration.server");
      const res = await handleOmniLinkRequest(
        new Request("https://jackboy.lovable.app/api/public/omni/link", { method: "POST", body: JSON.stringify(reqBody()) }),
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "authentication_failed" });
    } finally {
      spy.mockRestore();
    }
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("./untyped-db", () => ({ untyped: () => ({ rpc: mocks.rpc }) }));

import { handleDispatchCallback } from "./omni-dispatch-callback.server";
import { dispatchPayloadDigest } from "./omni-dispatch-digest";
import { hmacHex } from "./omni-link";

const path = "/api/public/omni/callback";
const V3 = "jackboy.dispatch-callback/v3";
const V2 = "jackboy.dispatch-callback/v2";
const settings = { clientId: "mothership", secret: "test-secret-0123456789-0123456789-0123456789" };
const owner = "11111111-1111-4111-8111-111111111111";
const project = "22222222-2222-4222-8222-222222222222";
const grant = "33333333-3333-4333-8333-333333333333";
const job = "44444444-4444-4444-8444-444444444444";
const grantRow = {
  valid: true,
  id: grant,
  ownerId: owner,
  projectId: project,
  jobId: job,
  repo: "acme/repo",
  kind: "test",
  instructions: "bounded request",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};
let digest = "";
const result = { passed: true, summary: "3 packages ok", output: "ok  acme/repo 0.4s", truncated: false };
const v3Body = () => ({
  contract: V3,
  ownerId: owner,
  projectId: project,
  grantId: grant,
  jobId: job,
  repo: "acme/repo",
  payloadDigest: digest,
  status: "completed",
  result,
});

let nonceCounter = 0;
async function signed(
  data: unknown,
  { contract = V3, secret = settings.secret, nonce }: { contract?: string; secret?: string; nonce?: string } = {},
) {
  const raw = JSON.stringify(data);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const n = nonce ?? (++nonceCounter).toString(16).padStart(32, "0");
  const signature = await hmacHex(
    secret,
    `${contract}\nPOST\n${path}\n${settings.clientId}\n${timestamp}\n${n}\n${raw}`,
  );
  return new Request(`https://jackboy.example${path}`, {
    method: "POST",
    headers: {
      "x-omni-contract": contract,
      "x-omni-client": settings.clientId,
      "x-omni-timestamp": timestamp,
      "x-omni-nonce": n,
      "x-omni-signature": signature,
    },
    body: raw,
  });
}

const READS = ["omni_dispatch_grant_action", "omni_dispatch_v3_callback_scope"];
const recordCalls = () => mocks.rpc.mock.calls.filter(([name]) => !READS.includes(name));
/** Jobs Jackboy submitted via v3 (mirrors omni_dispatch_v3_jobs rows written by the dispatch path). */
let submitted = new Set<string>();

beforeEach(async () => {
  digest = await dispatchPayloadDigest({ ...grantRow, kind: "test", grantId: grant });
  const seen = new Set<string>();
  submitted = new Set([job]);
  mocks.rpc.mockReset().mockImplementation((name: string, args: { _nonce?: string; _job?: string }) => {
    if (name === "omni_dispatch_grant_action") return Promise.resolve({ data: grantRow, error: null });
    if (name === "omni_dispatch_v3_callback_scope")
      return Promise.resolve({
        data: submitted.has(args._job ?? "") ? { found: true, ...grantRow } : { found: false },
        error: null,
      });
    // Mirrors the database nonce table: a second use of the same nonce is refused.
    if (args._nonce && seen.has(args._nonce))
      return Promise.resolve({ data: null, error: { message: "Callback replay" } });
    if (args._nonce) seen.add(args._nonce);
    return Promise.resolve({ data: { recorded: true }, error: null });
  });
});

describe("v3 scoped dispatch callback", () => {
  it("valid path: verifies grant + digest, stores status and result, signs the v3 response", async () => {
    const nonce = "c".repeat(32);
    const response = await handleDispatchCallback(await signed(v3Body(), { nonce }), settings);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toEqual({ contract: V3, requestNonce: nonce, status: "completed" });
    expect(response.headers.get("x-omni-proof")).toBe(
      await hmacHex(settings.secret, `${V3}\nresponse\n${nonce}\n200\n${body}`),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("omni_dispatch_v3_callback_scope", {
      _owner: owner,
      _job: job,
      _grant: grant,
    });
    expect(recordCalls()).toEqual([
      [
        "omni_dispatch_v3_record",
        {
          _source: "callback",
          _nonce: nonce,
          _owner: owner,
          _project: project,
          _job: job,
          _grant: grant,
          _repo: "acme/repo",
          _status: "completed",
          _result: result,
        },
      ],
    ]);
  });

  it("stores a running status with no result", async () => {
    const { result: _r, ...rest } = v3Body();
    const response = await handleDispatchCallback(await signed({ ...rest, status: "running" }), settings);
    expect(response.status).toBe(200);
    expect(recordCalls()[0]?.[1]).toMatchObject({ _status: "running", _result: null });
  });

  it("rejects a bad signature before reading the grant", async () => {
    const response = await handleDispatchCallback(
      await signed(v3Body(), { secret: "wrong-secret-0123456789-0123456789-0123" }),
      settings,
    );
    expect(response.status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects a v3 body signed with the v2 contract string", async () => {
    const request = await signed(v3Body(), { contract: V2 });
    request.headers.set("x-omni-contract", V3);
    expect((await handleDispatchCallback(request, settings)).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("rejects wrong scope (project or repo) without storing", async () => {
    for (const change of [
      { projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      { repo: "other/repo" },
    ]) {
      const response = await handleDispatchCallback(await signed({ ...v3Body(), ...change }), settings);
      expect(response.status).toBe(503);
    }
    expect(recordCalls()).toHaveLength(0);
  });

  it("rejects a digest mismatch without storing", async () => {
    const response = await handleDispatchCallback(
      await signed({ ...v3Body(), payloadDigest: "f".repeat(64) }),
      settings,
    );
    expect(response.status).toBe(503);
    expect(recordCalls()).toHaveLength(0);
  });

  it("rejects a pre-run quarantined callback on an expired grant without storing", async () => {
    mocks.rpc.mockImplementation((name: string) =>
      Promise.resolve(
        name === "omni_dispatch_grant_action"
          ? { data: { valid: false, reason: "grant_expired" }, error: null }
          : { data: { recorded: true }, error: null },
      ),
    );
    const { result: _r, ...rest } = v3Body();
    const response = await handleDispatchCallback(await signed({ ...rest, status: "quarantined" }), settings);
    expect(response.status).toBe(503);
    expect(recordCalls()).toHaveLength(0);
  });

  describe("result callbacks after the approval window", () => {
    // The live check would refuse: grant expired 20 minutes ago and the link is stale.
    const expiredGrant = { ...grantRow, expiresAt: new Date(Date.now() - 20 * 60_000).toISOString() };
    beforeEach(() => {
      const fallback = mocks.rpc.getMockImplementation()!;
      mocks.rpc.mockImplementation((name: string, args: { _job?: string }) => {
        if (name === "omni_dispatch_grant_action")
          return Promise.resolve({ data: { valid: false, reason: "grant_expired" }, error: null });
        if (name === "omni_dispatch_v3_callback_scope")
          return Promise.resolve({
            data: submitted.has(args._job ?? "") ? { found: true, ...expiredGrant } : { found: false },
            error: null,
          });
        return fallback(name, args);
      });
    });

    it("accepts a completed result 20 minutes after the grant expired", async () => {
      const response = await handleDispatchCallback(await signed(v3Body()), settings);
      expect(response.status).toBe(200);
      expect(mocks.rpc.mock.calls.map(([name]) => name)).not.toContain("omni_dispatch_grant_action");
      expect(recordCalls()).toEqual([
        ["omni_dispatch_v3_record", expect.objectContaining({ _status: "completed", _result: result })],
      ]);
    });

    it("rejects a result for a job that was never submitted via v3", async () => {
      submitted.clear();
      const response = await handleDispatchCallback(await signed(v3Body()), settings);
      expect(response.status).toBe(503);
      expect(response.headers.get("x-omni-proof")).toBeNull();
      expect(recordCalls()).toHaveLength(0);
    });

    it("rejects a wrong payload digest", async () => {
      const response = await handleDispatchCallback(
        await signed({ ...v3Body(), payloadDigest: "a".repeat(64) }),
        settings,
      );
      expect(response.status).toBe(503);
      expect(recordCalls()).toHaveLength(0);
    });

    it("rejects a changed scope (project, repo, job or grant)", async () => {
      for (const change of [
        { projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
        { repo: "other/repo" },
        { jobId: "55555555-5555-4555-8555-555555555555" },
      ]) {
        const response = await handleDispatchCallback(await signed({ ...v3Body(), ...change }), settings);
        expect(response.status).toBe(503);
      }
      expect(recordCalls()).toHaveLength(0);
    });
  });

  it("refuses a replayed nonce", async () => {
    const nonce = "d".repeat(32);
    expect((await handleDispatchCallback(await signed(v3Body(), { nonce }), settings)).status).toBe(200);
    const replay = await handleDispatchCallback(await signed(v3Body(), { nonce }), settings);
    expect(replay.status).toBe(503);
    expect(replay.headers.get("x-omni-proof")).toBeNull();
  });

  it("rejects oversized output, long summaries, unknown fields and results on non-final states", async () => {
    for (const data of [
      { ...v3Body(), result: { ...result, output: "x".repeat(6 * 1024 + 1) } },
      { ...v3Body(), result: { ...result, output: "é".repeat(3 * 1024 + 1) } },
      { ...v3Body(), result: { ...result, summary: "s".repeat(501) } },
      { ...v3Body(), result: { ...result, extra: 1 } },
      { ...v3Body(), extra: true },
      { ...v3Body(), status: "running" },
      { ...v3Body(), status: "approved", result: undefined },
    ]) {
      expect((await handleDispatchCallback(await signed(data), settings)).status).toBe(400);
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("accepts output of exactly 6 KB", async () => {
    const data = { ...v3Body(), result: { ...result, output: "x".repeat(6 * 1024), truncated: true } };
    expect((await handleDispatchCallback(await signed(data), settings)).status).toBe(200);
  });
});

describe("v2 callback still works unchanged", () => {
  it("records through the v2 database path and signs with the v2 contract", async () => {
    const nonce = "e".repeat(32);
    const data = {
      contract: V2,
      ownerId: owner,
      projectId: project,
      grantId: grant,
      jobId: job,
      repo: "acme/repo",
      payloadDigest: digest,
      status: "quarantined",
    };
    const response = await handleDispatchCallback(await signed(data, { contract: V2, nonce }), settings);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-omni-proof")).toBe(
      await hmacHex(settings.secret, `${V2}\nresponse\n${nonce}\n200\n${body}`),
    );
    expect(recordCalls()).toEqual([
      [
        "omni_dispatch_callback_record",
        {
          _nonce: nonce,
          _owner: owner,
          _project: project,
          _job: job,
          _grant: grant,
          _repo: "acme/repo",
          _status: "quarantined",
        },
      ],
    ]);
  });

  it("v2 still refuses v3-only states and result fields", async () => {
    const base = {
      contract: V2,
      ownerId: owner,
      projectId: project,
      grantId: grant,
      jobId: job,
      repo: "acme/repo",
      payloadDigest: digest,
    };
    for (const data of [
      { ...base, status: "completed" },
      { ...base, status: "quarantined", result },
    ])
      expect((await handleDispatchCallback(await signed(data, { contract: V2 }), settings)).status).toBe(400);
  });
});

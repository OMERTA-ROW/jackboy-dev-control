import { describe, expect, it, vi } from "vitest";
import { hmacHex } from "./omni-link";
import {
  HANDOFF_CONTRACT as contract,
  HANDOFF_PATH as path,
  handoffConfig,
  handoffPublicStatus,
  handoffResponseInput,
  handoffSigningInput,
  sha256Hex,
} from "./omni-handoff-v1";
import { handleOmniHandoffV1, type HandoffDeps } from "./omni-handoff-v1.server";

const settings = {
  clientId: "evolution-mothership",
  secret: "s".repeat(32) + "-handoff-test-secret",
};
const NOW = 1_794_450_000_000;
const now = () => NOW;
const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectId = "22222222-2222-4222-8222-222222222222";
const jobId = "44444444-4444-4444-8444-444444444444";
const instructions = "Run the test suite and report results.";

async function createBody(overrides: Record<string, unknown> = {}) {
  return {
    action: "create",
    taskId,
    projectId,
    repo: "OMERTA-ROW/jackboy-dev-control",
    kind: "test",
    instructions,
    digest: await sha256Hex(instructions),
    ...overrides,
  };
}

let nonceCounter = 0;
async function request(
  body: unknown,
  opts: {
    secret?: string;
    timestamp?: string;
    nonce?: string;
    client?: string;
    raw?: string;
    url?: string;
  } = {},
) {
  const raw = opts.raw ?? JSON.stringify(body);
  const timestamp = opts.timestamp ?? String(Math.floor(NOW / 1000));
  const nonce = opts.nonce ?? (++nonceCounter).toString(16).padStart(32, "0");
  const client = opts.client ?? settings.clientId;
  const signature = await hmacHex(
    opts.secret ?? settings.secret,
    handoffSigningInput(client, timestamp, nonce, raw),
  );
  return new Request(opts.url ?? `https://jackboy.example${path}`, {
    method: "POST",
    headers: {
      "x-jackboy-contract": contract,
      "x-jackboy-client": client,
      "x-jackboy-timestamp": timestamp,
      "x-jackboy-nonce": nonce,
      "x-jackboy-signature": signature,
    },
    body: raw,
  });
}

/** In-memory stand-in with the same idempotency rules as the omni_handoff_create RPC. */
function memoryDeps(options: { paused?: string | null } = {}) {
  const nonces = new Set<string>();
  const tasks = new Map<
    string,
    { jobId: string; digest: string; projectId: string; instructions: string }
  >();
  const jobs = new Map<string, string>();
  const audit = vi.fn<HandoffDeps["audit"]>().mockResolvedValue(undefined);
  const create = vi.fn<HandoffDeps["create"]>(async (input) => {
    const existing = tasks.get(input.taskId);
    if (existing) {
      if (existing.digest !== input.digest || existing.projectId !== input.projectId)
        return { outcome: "refused", reason: "task_conflict" };
      return { outcome: "existing", jobId: existing.jobId, status: jobs.get(existing.jobId)! };
    }
    const id =
      jobs.size === 0 ? jobId : `55555555-5555-4555-8555-${String(jobs.size).padStart(12, "0")}`;
    jobs.set(id, "queued");
    tasks.set(input.taskId, {
      jobId: id,
      digest: input.digest,
      projectId: input.projectId,
      instructions: input.instructions,
    });
    return { outcome: "created", jobId: id, status: "queued" };
  });
  const deps: HandoffDeps = {
    claimNonce: vi.fn(async (nonce: string) => {
      if (nonces.has(nonce)) return "replay" as const;
      nonces.add(nonce);
      return "ok" as const;
    }),
    killSwitch: vi.fn(async () => options.paused ?? null),
    create,
    status: vi.fn(async (id: string) => {
      const t = tasks.get(id);
      return t ? { jobId: t.jobId, status: jobs.get(t.jobId)! } : null;
    }),
    audit,
  };
  return { deps, audit, create, jobs };
}

const call = (req: Request, deps: HandoffDeps, s: typeof settings | null = settings) =>
  handleOmniHandoffV1(req, s, deps, now);

describe("handoff configuration", () => {
  it("is off unless enabled is exactly 'true' and the secret is at least 32 characters", () => {
    const base = { JACKBOY_HANDOFF_CLIENT_ID: "m", JACKBOY_HANDOFF_HMAC_SECRET: "x".repeat(32) };
    expect(handoffConfig(base)).toBeNull();
    expect(handoffConfig({ ...base, JACKBOY_HANDOFF_ENABLED: "TRUE" })).toBeNull();
    expect(
      handoffConfig({
        ...base,
        JACKBOY_HANDOFF_ENABLED: "true",
        JACKBOY_HANDOFF_HMAC_SECRET: "x".repeat(31),
      }),
    ).toBeNull();
    expect(handoffConfig({ ...base, JACKBOY_HANDOFF_ENABLED: "true" })).toEqual({
      clientId: "m",
      secret: "x".repeat(32),
    });
  });
});

describe("POST /api/public/omni-handoff/v1", () => {
  it("returns 503 when disabled and touches nothing", async () => {
    const { deps, audit, create } = memoryDeps();
    const res = await call(await request(await createBody()), deps, null);
    expect(res.status).toBe(503);
    expect(create).not.toHaveBeenCalled();
    expect(deps.claimNonce).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("rejects a bad signature with 401 before using the nonce", async () => {
    const { deps, create, audit } = memoryDeps();
    const res = await call(await request(await createBody(), { secret: "w".repeat(40) }), deps);
    expect(res.status).toBe(401);
    expect(deps.claimNonce).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(audit.mock.calls[0]![0]).toMatchObject({
      action: "omni.handoff.refused",
      detail: { reason: "bad_signature" },
    });
  });

  it("rejects timestamps more than 60 seconds off with 401", async () => {
    const { deps, create } = memoryDeps();
    const stale = String(Math.floor(NOW / 1000) - 61);
    const future = String(Math.floor(NOW / 1000) + 61);
    expect((await call(await request(await createBody(), { timestamp: stale }), deps)).status).toBe(
      401,
    );
    expect(
      (await call(await request(await createBody(), { timestamp: future }), deps)).status,
    ).toBe(401);
    const edge = String(Math.floor(NOW / 1000) - 60);
    expect((await call(await request(await createBody(), { timestamp: edge }), deps)).status).toBe(
      201,
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects a replayed nonce with 401", async () => {
    const { deps, create } = memoryDeps();
    const nonce = "c".repeat(32);
    expect((await call(await request(await createBody(), { nonce }), deps)).status).toBe(201);
    expect((await call(await request(await createBody(), { nonce }), deps)).status).toBe(401);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects the wrong client, plain http, query strings and oversized bodies", async () => {
    const { deps, create } = memoryDeps();
    expect(
      (await call(await request(await createBody(), { client: "someone-else" }), deps)).status,
    ).toBe(401);
    expect(
      (
        await call(
          await request(await createBody(), { url: `http://jackboy.example${path}` }),
          deps,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          await request(await createBody(), { url: `https://jackboy.example${path}?x=1` }),
          deps,
        )
      ).status,
    ).toBe(400);
    const big = JSON.stringify(await createBody({ instructions: "x".repeat(9000) }));
    expect((await call(await request(null, { raw: big }), deps)).status).toBe(413);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses create while the Kill Switch is on (or unreadable) and queues nothing", async () => {
    const { deps, create, audit } = memoryDeps({
      paused: "Kill Switch is on — all Jackboy work is paused.",
    });
    const res = await call(await request(await createBody()), deps);
    expect(res.status).toBe(423);
    expect(await res.json()).toMatchObject({ error: "kill_switch_on" });
    expect(create).not.toHaveBeenCalled();
    expect(audit.mock.calls.at(-1)![0]).toMatchObject({
      action: "omni.handoff.refused",
      detail: { reason: "kill_switch_on" },
    });

    const failing = memoryDeps();
    failing.deps.killSwitch = vi.fn().mockRejectedValue(new Error("db down"));
    expect((await call(await request(await createBody()), failing.deps)).status).toBe(423);
    expect(failing.create).not.toHaveBeenCalled();
  });

  it("refuses a digest that is not sha256(instructions)", async () => {
    const { deps, create } = memoryDeps();
    const res = await call(await request(await createBody({ digest: "0".repeat(64) })), deps);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "digest_mismatch" });
    expect(create).not.toHaveBeenCalled();
  });

  it("creates once per taskId, returns the original job on repeat, and signs the response", async () => {
    const { deps, create, audit, jobs } = memoryDeps();
    const first = await call(await request(await createBody(), { nonce: "d".repeat(32) }), deps);
    const firstText = await first.text();
    expect(first.status).toBe(201);
    expect(JSON.parse(firstText)).toMatchObject({
      contract,
      requestNonce: "d".repeat(32),
      jackboyJobId: jobId,
      status: "queued",
    });
    expect(first.headers.get("x-jackboy-proof")).toBe(
      await hmacHex(settings.secret, handoffResponseInput("d".repeat(32), 201, firstText)),
    );
    const again = await call(await request(await createBody()), deps);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ jackboyJobId: jobId, status: "queued" });
    expect(jobs.size).toBe(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls.map((c) => c[0].action)).toEqual([
      "omni.handoff.create",
      "omni.handoff.create",
    ]);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(instructions);
  });

  it("refuses reuse of a taskId with different instructions", async () => {
    const { deps } = memoryDeps();
    await call(await request(await createBody()), deps);
    const other = "Different instructions entirely.";
    const res = await call(
      await request(await createBody({ instructions: other, digest: await sha256Hex(other) })),
      deps,
    );
    expect(res.status).toBe(409);
  });

  it("maps database refusals (project not enrolled / repo mismatch) to 403", async () => {
    const { deps } = memoryDeps();
    deps.create = vi
      .fn()
      .mockResolvedValue({ outcome: "refused", reason: "project_not_authorized" });
    expect((await call(await request(await createBody()), deps)).status).toBe(403);
  });

  it("status returns only the job id and status — never instructions, results or secrets", async () => {
    const { deps, audit } = memoryDeps();
    await call(await request(await createBody()), deps);
    const res = await call(await request({ action: "status", taskId }), deps);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual([
      "contract",
      "jackboyJobId",
      "requestNonce",
      "status",
    ]);
    expect(JSON.parse(text)).toMatchObject({ jackboyJobId: jobId, status: "queued" });
    expect(text).not.toContain(instructions);
    expect(text).not.toContain(settings.secret);
    expect(audit.mock.calls.at(-1)![0].action).toBe("omni.handoff.status");
    expect(JSON.stringify(audit.mock.calls)).not.toContain(settings.secret);
  });

  it("status for an unknown task is 404 and extra fields are rejected", async () => {
    const { deps } = memoryDeps();
    expect((await call(await request({ action: "status", taskId }), deps)).status).toBe(404);
    expect(
      (await call(await request({ action: "status", taskId, instructions: "x" }), deps)).status,
    ).toBe(400);
  });
});

describe("handoffPublicStatus", () => {
  it("prefers the dispatch v3 state and hides unknown values", () => {
    expect(handoffPublicStatus("queued", null)).toBe("queued");
    expect(handoffPublicStatus("sent", "quarantined")).toBe("quarantined");
    expect(handoffPublicStatus("weird", null)).toBe("unknown");
  });
});
